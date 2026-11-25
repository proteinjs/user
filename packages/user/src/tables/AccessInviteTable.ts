import type { Moment } from 'moment';

import {
  BooleanColumn,
  DateTimeColumn,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  getDbAsSystem,
  QueryBuilderFactory,
  Record,
  Reference,
  ReferenceColumn,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';
import * as crypto from 'crypto';
import { UserRepo } from '../UserRepo';
import { AccessGrant, AccessGrantTable } from './AccessGrantTable';
import { User, UserTable } from './UserTable';

export type AccessInvite<T extends Record = any> = Record & {
  token?: string;
  tokenExpiresAt: Moment;
  resource: Reference<T>;
  resourceTable: string;
  accessLevel: AccessGrant['accessLevel'];
  /** LAST-accept telemetry only — invites are multi-use until expiry; these never gate acceptance. */
  accepted?: boolean;
  acceptedBy?: Reference<User>;
  acceptedAt?: Moment;
  /**
   * THE MINTER — the account that created this invite, stamped from the caller at the mint. The one
   * durable "who shared this": an accepted invite copies it onto the grant it confers
   * (`AccessGrant.grantedBy`), so a recipient's grant names the person who sent the link, never the
   * last account that happened to open a multi-use link (the telemetry above). Absent only on a
   * system mint with no caller behind it.
   */
  createdBy?: Reference<User>;
};

export class AccessInviteTable extends Table<AccessInvite> {
  name = 'access_invite';
  /**
   * THE TABLE'S OWN DOORS: A CALLER MINTS, THE BREAK-GLASS ADMIN READS, AND THE REST IS THE SYSTEM'S.
   * - db block: `insert` for a signed-in caller. That is the mint: `AccessInviteService.createAccessInvite`
   *   inserts as the caller, and the mint's own check (the `resourceTable` column's `onBeforeInsert`) asks
   *   admin or owner on the resource. Query, update and delete are not declared there, and inside a declared
   *   block an undeclared operation is closed to everyone, but that the admin's query mirrors the service
   *   block's admin-only door (`TableAuth`).
   * - service block: `query` for the break-glass admin alone, so a generic record page lists this table for
   *   the admin as it lists every table. Insert, update and delete are not declared: the table service runs
   *   none of them on this table for anyone.
   * A row holds the token an accept asks for and names what an accept confers. Changing a row and removing
   * one are made as the system alone: the accept finds its row by token and stamps it, and a consumer that
   * ends a resource's links expires them in place after its own check.
   */
  auth: Table<AccessInvite>['auth'] = {
    db: {
      insert: 'authenticated',
    },
    service: {
      query: ['admin'],
    },
  };
  /**
   * The admin's row scan: what an invite is for, at what level, by whom, until when. Never the
   * redeemable `token`, which stays on the record form, as on the invite table's own row scan.
   */
  ui: Table<AccessInvite>['ui'] = {
    recordTable: {
      columns: ['resourceTable', 'resource', 'accessLevel', 'createdBy', 'tokenExpiresAt'],
    },
  };
  columns = withRecordColumns<AccessInvite>({
    token: new StringColumn('token', {
      defaultValue: async () => crypto.randomBytes(32).toString('hex'),
      forceDefaultValue: true,
    }),
    tokenExpiresAt: new DateTimeColumn('expires_at'),
    accepted: new BooleanColumn('accepted', { defaultValue: async () => false }),
    acceptedBy: new ReferenceColumn('accepted_by', new UserTable().name, false),
    acceptedAt: new DateTimeColumn('accepted_at'),
    // The minter, stamped at the table so EVERY mint road carries it — a caller's insert names the
    // caller; a system insert keeps whatever the writer set (nothing, when no one is behind it).
    createdBy: new ReferenceColumn('created_by', new UserTable().name, false, {
      onBeforeInsert: async (_table, insertObj: AccessInvite, runAsSystem) => {
        if (runAsSystem || insertObj.createdBy?._id) {
          return;
        }
        const callerId = new UserRepo().getUser().id;
        if (callerId) {
          insertObj.createdBy = new Reference<User>(new UserTable().name, callerId);
        }
      },
    }),
    accessLevel: new StringColumn('access_level'),
    resource: new DynamicReferenceColumn('resource', 'resource_table'),
    resourceTable: new DynamicReferenceTableNameColumn('resource_table', 'resource', {
      onBeforeInsert: async (_table, insertObj: AccessInvite, runAsSystem) => {
        if (runAsSystem) {
          return;
        }

        // OWNER CEILING: an accepted invite confers its grant as SYSTEM (AccessGrant's insert hook
        // short-circuits for system context), so the grant-side owner ceiling is not reachable
        // through acceptance. Enforce the same ceiling at the MINT: minting an OWNER invite requires
        // the caller ALREADY hold owner — otherwise a merely-admin collaborator could mint an
        // owner-invite and confer owner through acceptance, bypassing the ceiling. Any lesser invite
        // still requires admin/owner.
        const invitesOwner = insertObj.accessLevel === 'owner';
        const acceptableCallerLevels = invitesOwner ? ['owner'] : ['admin', 'owner'];

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

        const hasSufficientAccess =
          (await getDbAsSystem().query(new AccessGrantTable() as Table<AccessGrant>, adminAccessQb)).length > 0;

        if (!hasSufficientAccess) {
          throw new Error(
            invitesOwner ? `Only an owner can confer owner access` : `User does not have admin access to resource`
          );
        }
      },
    }),
  });
}
