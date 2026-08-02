import {
  BooleanColumn,
  StringColumn,
  PasswordColumn,
  Table,
  Record,
  withRecordColumns,
  UuidColumn,
  DateTimeColumn,
} from '@proteinjs/db';
import { Moment } from 'moment';

export type User = Record & {
  name: string;
  email: string;
  password: string;
  passwordResetToken?: string | null;
  passwordResetTokenExpiration?: Moment | null;
  emailVerified: boolean;
  roles: string;
  invitedBy?: string | null;
};

export class UserTable extends Table<User> {
  name = 'user';
  columns = withRecordColumns<User>({
    name: new StringColumn('name'),
    email: new StringColumn('email', {}, 250),
    password: new PasswordColumn('password'),
    // Server-internal credential state: the reset token is a live capability (its holder can take
    // the account), and the expiration is meaningless without it. Hidden from generic UI (record
    // table/form) — like `password` — so admin surfaces show the user roster, not secrets.
    passwordResetToken: new StringColumn('password_reset_token', { ui: { hidden: true } }),
    passwordResetTokenExpiration: new DateTimeColumn('password_reset_token_expiration', { ui: { hidden: true } }),
    emailVerified: new BooleanColumn('email_verified'),
    roles: new StringColumn('roles'),
    invitedBy: new StringColumn('invited_by'),
  });
}
