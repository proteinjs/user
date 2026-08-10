import { StringColumn, Table, Record, withRecordColumns, DateTimeColumn } from '@proteinjs/db';
import { Moment } from 'moment';
import { USER_PERMISSIONS } from '../permissions';

export type Invite = Record & {
  email: string;
  token: string | null;
  tokenExpiresAt: Moment | null;
  invitedBy: string;
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
  columns = withRecordColumns<Invite>({
    email: new StringColumn('email', {}, 250),
    token: new StringColumn('token'),
    tokenExpiresAt: new DateTimeColumn('token_expires_at'),
    invitedBy: new StringColumn('invited_by'),
  });
}
