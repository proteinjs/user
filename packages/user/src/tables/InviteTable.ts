import {
  StringColumn,
  Table,
  Record,
  withRecordColumns,
  DateTimeColumn,
  Reference,
  ReferenceColumn,
} from '@proteinjs/db';
import { Moment } from 'moment';
import { USER_PERMISSIONS } from '../permissions';
import { User, UserTable } from './UserTable';

export type Invite = Record & {
  email: string;
  token: string | null;
  tokenExpiresAt: Moment | null;
  invitedBy: Reference<User>;
};

export class InviteTable extends Table<Invite> {
  name = 'invite';
  /**
   * Invite management rides the 'users' permission: reads and deletes through the record
   * surfaces; creating/refreshing an invite is `SignupService.sendInvite` ONLY (a generic insert
   * would mint an invite that can never be redeemed — no token/expiry/inviter), so generic
   * writes stay closed. The db doors mirror the service doors — `DbService`'s inner `Db`
   * re-checks the db api as the calling user (see the user table); server code proper uses
   * system paths, which bypass TableAuth.
   *
   * The record table's create act is a DECLARED list action (`ui.recordTable.actions`), not an
   * insert door: the generic surfaces derive the `+` from the insert doors, and with those closed
   * by design the table drew no way to reach the new-record form's own Send act (no `+` on
   * Invites, on any form factor). The action's door names exactly who the send act serves; the
   * act stays gated in the form (`InviteRecordFormCustomization`) and in `SignupService`.
   */
  auth: Table<Invite>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    },
  };
  /**
   * The row scan: who's invited, by whom, until when. The redeemable `token` is auth material
   * with no business in a row scan (also a hygiene win); it stays
   * on the record form for the odd support case. The list actions: the create act, for 'users'
   * holders, named for what it is — an invite is sent, never "created" (the form's button says
   * the same); the delete act stays derived from the delete doors.
   */
  ui: Table<Invite>['ui'] = {
    recordTable: {
      columns: ['email', 'invitedBy', 'tokenExpiresAt'],
      actions: [{ kind: 'create', label: 'Send invite', door: { permission: USER_PERMISSIONS.users } }],
    },
  };
  columns = withRecordColumns<Invite>({
    email: new StringColumn('email', {}, 250),
    token: new StringColumn('token'),
    tokenExpiresAt: new DateTimeColumn('token_expires_at'),
    /**
     * A reference at the column's ORIGINAL string width: `invited_by` predates the reference
     * type as a STRING(255) uuid column, and a reference stores the same id bytes — adopting
     * the existing width (`maxLength`) makes the retype invisible to the schema sync (zero DDL;
     * Spanner could not narrow to the 36 default in place anyway).
     */
    invitedBy: new ReferenceColumn<User>('invited_by', new UserTable().name, false, { maxLength: 255 }),
  });
}
