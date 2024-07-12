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
};

export class UserTable extends Table<User> {
  name = 'user';
  columns = withRecordColumns<User>({
    name: new StringColumn('name'),
    email: new StringColumn('email', {}, 250),
    password: new PasswordColumn('password'),
    passwordResetToken: new StringColumn('password_reset_token'),
    passwordResetTokenExpiration: new DateTimeColumn('password_reset_token_expiration'),
    emailVerified: new BooleanColumn('email_verified'),
    roles: new StringColumn('roles'),
  });
}
