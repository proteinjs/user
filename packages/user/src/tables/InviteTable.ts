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
   * with no business in a row scan (founder admin review, v1.22 — also a hygiene win); it stays
   * on the record form for the odd support case. The doors above (no insert) already mean the
   * generic surfaces derive no create affordance — invites are minted by SignupService.sendInvite.
   */
  ui: Table<Invite>['ui'] = {
    recordTable: {
      columns: ['email', 'invitedBy', 'tokenExpiresAt'],
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
