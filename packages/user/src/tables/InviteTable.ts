import { StringColumn, Table, Record, withRecordColumns, DateTimeColumn } from '@proteinjs/db';
import { Moment } from 'moment';

export type Invite = Record & {
  email: string;
  token: string | null;
  tokenExpiresAt: Moment | null;
  invitedBy: string;
};

export class InviteTable extends Table<Invite> {
  name = 'invite';
  columns = withRecordColumns<Invite>({
    email: new StringColumn('email', {}, 250),
    token: new StringColumn('token'),
    tokenExpiresAt: new DateTimeColumn('token_expires_at'),
    invitedBy: new StringColumn('invited_by'),
  });
}
