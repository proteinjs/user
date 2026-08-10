import {
  ArrayColumn,
  BooleanColumn,
  StringColumn,
  PasswordColumn,
  Table,
  Record,
  withRecordColumns,
  DateTimeColumn,
} from '@proteinjs/db';
import { Moment } from 'moment';
import { USER_PERMISSIONS } from '../permissions';

export type User = Record & {
  name: string;
  email: string;
  password: string;
  passwordResetToken?: string | null;
  passwordResetTokenExpiration?: Moment | null;
  emailVerified: boolean;
  /** Role names from the roles catalog (see `RolesCatalog`). Written ONLY by the Roles service. */
  roles: string[];
  invitedBy?: string | null;
};

export class UserTable extends Table<User> {
  name = 'user';
  /**
   * The 'users' permission covers viewing and managing user records — EXCEPT roles. The roles
   * column is service-protected: the ONLY write path is the Roles service (permission 'roles'),
   * which also writes the role_grant_event audit row per change. The db api is left unspecified
   * (admin door) — server code uses system paths.
   */
  auth: Table<User>['auth'] = {
    service: {
      query: { permission: USER_PERMISSIONS.users },
      insert: { permission: USER_PERMISSIONS.users },
      update: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    },
    serviceProtectedColumns: ['roles'],
  };
  columns = withRecordColumns<User>({
    name: new StringColumn('name'),
    email: new StringColumn('email', {}, 250),
    password: new PasswordColumn('password'),
    passwordResetToken: new StringColumn('password_reset_token'),
    passwordResetTokenExpiration: new DateTimeColumn('password_reset_token_expiration'),
    emailVerified: new BooleanColumn('email_verified'),
    /**
     * Typed array in the `role_list` column. The legacy comma-string `roles` column (STRING(255))
     * stays physically present but undeclared — Spanner cannot retype in place, so the cutover is
     * new column + backfill (`@proteinjs/user-server` BackfillUserRolesArray) + this code cutover.
     */
    roles: new ArrayColumn<string>('role_list'),
    invitedBy: new StringColumn('invited_by'),
  });
}
