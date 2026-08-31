import {
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  getDbAsSystem,
  QueryBuilder,
  QueryBuilderFactory,
  Record,
  Reference,
  ReferenceColumn,
  StringColumn,
  withRecordColumns,
} from '@proteinjs/db';

import { Table } from '@proteinjs/db';
import { User } from './UserTable';
import { UserRepo } from '../UserRepo';

export type AccessGrant = Record & {
  principal: Reference<any>;
  resource: Reference<any>;
  resourceTable?: Table<any>['name'];
  accessLevel: 'read' | 'write' | 'admin' | 'owner';
};

/**
 * Capability ordering for access levels — the one owner for "which level outranks which".
 * Mirrors SharedRecord's operation filters (read ⊂ write ⊂ admin ⊂ owner); consumers that
 * pick among multiple grants or compare an invite's level to an existing grant use this
 * instead of hand-rolling an order.
 */
export const ACCESS_LEVEL_RANK: { [L in AccessGrant['accessLevel']]: number } = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};

/**
 * The highest-capability level among `levels`, or undefined when empty. A principal can hold
 * several grants on one resource (an owner grant plus an accepted invite's write, say) —
 * capability questions must resolve to the MAX, never an arbitrary row.
 */
export function maxAccessLevel(levels: AccessGrant['accessLevel'][]): AccessGrant['accessLevel'] | undefined {
  let best: AccessGrant['accessLevel'] | undefined;
  for (const level of levels) {
    if (!best || ACCESS_LEVEL_RANK[level] > ACCESS_LEVEL_RANK[best]) {
      best = level;
    }
  }
  return best;
}

/**
 * An AccessGrant insert that names no principal or no resource. A grant is a (who, what, level)
 * triple; a row missing the who or the what is a capability for nobody on nothing, yet every
 * reader that joins on it (sweeps, deletion manifests, rosters) must then special-case NULL.
 * Name-tagged rather than `instanceof` (same reason as `RecordAccessError`: the prototype chain is
 * unreliable across package compile targets).
 */
export class MalformedAccessGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedAccessGrantError';
  }
}

export const isMalformedAccessGrantError = (error: unknown): error is MalformedAccessGrantError =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'MalformedAccessGrantError';

export class AccessGrantTable extends Table<AccessGrant> {
  name = 'access_grant';
  auth: Table<AccessGrant>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  indexes = [
    {
      name: 'idx_ag_principal_table_level_resource',
      columns: ['principal', 'resourceTable', 'accessLevel', 'resource'] satisfies (keyof AccessGrant)[],
    },
    // The resource-side axis: scope-root owner resolution (SharedScopeKeyOwners — per
    // encrypted write into a shared scope) and outbound-grant enumeration (deletion
    // manifests, rosters) look grants up BY RESOURCE; without this they scan.
    {
      name: 'idx_ag_resource_level_principal',
      columns: ['resource', 'accessLevel', 'principal'] satisfies (keyof AccessGrant)[],
    },
  ];
  columns: Table<AccessGrant>['columns'] = withRecordColumns<AccessGrant>({
    accessLevel: new StringColumn('access_level'),
    // The reference's TABLE name ('user' — matching invitedBy's declaration), never the class
    // name: `UserTable.name` is the class's static JS name ('UserTable'), which deserialize
    // stamped onto every read-back principal, breaking `principal.get()` and the admin table's
    // linked-name rendering. Stored cells are bare ids, so this is declaration-only (zero DDL).
    // WELL-FORMEDNESS INVARIANT (the malformed-grant class): `ReferenceColumn.serialize` stores
    // NULL for a Reference with no `_id`, and nothing below the table ever required one — so a
    // write path that forwarded an absent id (a session-less bootstrap's `getUser().id`, an RPC
    // arg passed through unchecked) landed a grant for nobody / on nothing. The refusal is the
    // table's, for SYSTEM writes too: a schema invariant has no privileged bypass.
    principal: new ReferenceColumn<User>('principal', 'user', false, {
      onBeforeInsert: async (_table, insertObj: AccessGrant) => this.assertWellFormed(insertObj),
    }),
    resource: new DynamicReferenceColumn<any>('resource', 'resource_table', false),
    resourceTable: new DynamicReferenceTableNameColumn('resource_table', 'resource', {
      onBeforeInsert: async (_table, insertObj: AccessGrant, runAsSystem) => {
        if (runAsSystem) {
          return;
        }

        // Require the caller to ALREADY hold sufficient access on the resource, queried directly as
        // SYSTEM (mirrors AccessInviteTable.onBeforeInsert). The former `resource.get()` escape —
        // "if the object doesn't exist yet, allow" — ran the fetch under the caller's READ scope,
        // so a caller with NO access saw undefined and skipped this check entirely, self-granting
        // admin/owner from a read grant or from zero/revoked access (the escalation hole). The
        // legitimate first-owner bootstrap no longer relies on this path: SharedRecord confers the
        // creator's owner grant as a system-context insert (runAsSystem short-circuits above).
        //
        // OWNER CEILING: conferring an OWNER grant requires the caller ALREADY hold owner — only an
        // owner makes another owner, so a merely-admin collaborator cannot mint themselves (or a
        // peer) an owner grant. Any lesser grant still requires admin/owner. Invite-accept confers
        // its grant as SYSTEM (runAsSystem short-circuits above), so this ceiling is not reachable
        // through an accepted invite — the mint side (AccessInviteTable) carries the matching gate.
        const grantsOwner = insertObj.accessLevel === 'owner';
        const acceptableCallerLevels = grantsOwner ? ['owner'] : ['admin', 'owner'];

        const adminAccessQb = new QueryBuilderFactory().createQueryBuilder(
          new AccessGrantTable() as Table<AccessGrant>,
          {
            principal: new UserRepo().getUser().id,
            resource: insertObj.resource._id,
            resourceTable: insertObj.resourceTable,
          }
        );

        adminAccessQb.condition({
          field: 'accessLevel',
          operator: 'IN',
          value: acceptableCallerLevels,
        });

        const hasSufficientAccess = (await getDbAsSystem().query(new AccessGrantTable(), adminAccessQb)).length > 0;

        if (!hasSufficientAccess) {
          throw new Error(
            grantsOwner ? `Only an owner can confer owner access` : `User does not have admin access to resource`
          );
        }
      },
      // Prevent direct updates and limit access to own or admin-accessible grants
      async addToQuery(qb, runAsSystem, operation) {
        if (runAsSystem) {
          return;
        }

        if (operation === 'write') {
          throw new Error('AccessGrants cannot be updated directly');
        }

        const currentUser = new UserRepo().getUser();

        const adminResourceSubQuery = new QueryBuilder(new AccessGrantTable().name);
        adminResourceSubQuery.select({ fields: ['resource'] });
        adminResourceSubQuery.condition({ field: 'principal', operator: '=', value: currentUser.id });
        adminResourceSubQuery.condition({ field: 'accessLevel', operator: 'IN', value: ['admin', 'owner'] });

        qb.or([
          { field: 'principal', operator: '=', value: currentUser.id },
          {
            field: 'resource',
            operator: 'IN',
            value: adminResourceSubQuery,
          },
        ]);

        // OWNER CEILING on the DELETE side (owner-immutability, defense-in-depth with the
        // ThoughtSharing service). The scope above lets a caller delete any grant on a resource they
        // ADMIN — which includes the resource OWNER's own grant. Without this, a merely-admin
        // collaborator skips ThoughtSharing entirely and calls getDb().delete(AccessGrant, {principal:
        // ownerId, resource, resourceTable}) directly through the generic DbService, deleting the
        // owner's grant. That is strictly worse than a revoke: conferring a replacement owner itself
        // requires an already-existing owner (the insert ceiling), so the thought is orphaned with no
        // recovery path. Mirror the insert ceiling on the delete side — deleting an OWNER grant
        // requires the caller to ALREADY hold owner on that resource. Non-owner grants are unaffected;
        // an owner-holder (already top of the ladder) retains owner-grant management for an atomic
        // transfer. Scoped to delete — read visibility is deliberately unchanged.
        if (operation === 'delete') {
          const ownerResourceSubQuery = new QueryBuilder(new AccessGrantTable().name);
          ownerResourceSubQuery.select({ fields: ['resource'] });
          ownerResourceSubQuery.condition({ field: 'principal', operator: '=', value: currentUser.id });
          ownerResourceSubQuery.condition({ field: 'accessLevel', operator: '=', value: 'owner' });

          qb.or([
            { field: 'accessLevel', operator: 'IN', value: ['read', 'write', 'admin'] },
            {
              field: 'resource',
              operator: 'IN',
              value: ownerResourceSubQuery,
            },
          ]);
        }
      },
    }),
  });

  /** Refuse a grant that names no principal id or no resource id (see {@link MalformedAccessGrantError}). */
  private async assertWellFormed(insertObj: AccessGrant): Promise<void> {
    const missing = (['principal', 'resource'] as const).filter((field) => !insertObj[field]?._id);
    if (missing.length > 0) {
      throw new MalformedAccessGrantError(
        `access_grant insert refused: ${missing.join(' and ')} reference has no id ` +
          `(resourceTable=${insertObj.resourceTable ?? insertObj.resource?._table ?? 'unknown'}, ` +
          `accessLevel=${insertObj.accessLevel})`
      );
    }
  }
}
