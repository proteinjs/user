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
import { User, UserTable } from './UserTable';
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
  ];
  columns = withRecordColumns<AccessGrant>({
    accessLevel: new StringColumn('access_level'),
    principal: new ReferenceColumn<User>('principal', UserTable.name, false),
    resource: new DynamicReferenceColumn<any>('resource', 'resource_table', false),
    resourceTable: new DynamicReferenceTableNameColumn('resource_table', 'resource', {
      onBeforeInsert: async (insertObj: AccessGrant, runAsSystem) => {
        if (runAsSystem) {
          return;
        }

        // Require the caller to ALREADY hold admin/owner on the resource, queried directly as
        // SYSTEM (mirrors AccessInviteTable.onBeforeInsert). The former `resource.get()` escape —
        // "if the object doesn't exist yet, allow" — ran the fetch under the caller's READ scope,
        // so a caller with NO access saw undefined and skipped this check entirely, self-granting
        // admin/owner from a read grant or from zero/revoked access (the escalation hole). The
        // legitimate first-owner bootstrap no longer relies on this path: SharedRecord confers the
        // creator's owner grant as a system-context insert (runAsSystem short-circuits above).
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
          value: ['admin', 'owner'],
        });

        const hasAdminAccess = (await getDbAsSystem().query(new AccessGrantTable(), adminAccessQb)).length > 0;

        if (!hasAdminAccess) {
          throw new Error(`User does not have admin access to resource`);
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
      },
    }),
  });
}
