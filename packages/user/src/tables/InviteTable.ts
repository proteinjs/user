import { StringColumn, Table, Record, withRecordColumns, DateTimeColumn } from '@proteinjs/db';
import { Moment } from 'moment';
import { InviteStatus } from '../services/SignupService';

export type Invite = Record & {
  email: string;
  status: InviteStatus;
  token?: string | null;
  tokenExpiresAt?: Moment | null;
};

export class InviteTable extends Table<Invite> {
  name = 'invite';
  columns = withRecordColumns<Invite>({
    email: new StringColumn('email', {}, 250),
    status: new StringColumn('status'),
    token: new StringColumn('token'),
    tokenExpiresAt: new DateTimeColumn('token_expires_at'),
  });
}
