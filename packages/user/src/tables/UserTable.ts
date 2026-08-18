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

/** Account standings. The vocabulary is owned here; every status write flows through the SetUserStatus service. */
export const USER_STATUSES = ['active', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

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
  /**
   * Emoji avatar. At most one of `avatarEmoji`/`avatarFileId` is set — the avatar mutations in
   * UpdateUserInfo enforce it (every mutation assigns BOTH columns); nothing else writes these.
   */
  avatarEmoji?: string | null;
  /**
   * File id of the stored avatar photo (512x512 JPEG). A plain string, NOT a ReferenceColumn:
   * @proteinjs/db-file depends on @proteinjs/user, so a user→file reference would be circular.
   */
  avatarFileId?: string | null;
  /**
   * Account standing. Written ONLY by the SetUserStatus service (audited per change). New rows
   * default to 'active'; rows predating the column read null, which every gate treats as active —
   * only an explicit 'deactivated' is refused (authentication and session resolution both gate on
   * it in @proteinjs/user-server).
   */
  status?: UserStatus | null;
  /** When the user asked for their account to be deleted. Written by the account-deletion flow only. */
  deleteRequestedAt?: Moment | null;
  /** When the grace window ends and the purge walker may erase the account. Written by the account-deletion flow only. */
  purgeAfter?: Moment | null;
};

export class UserTable extends Table<User> {
  name = 'user';
  /**
   * The 'users' permission covers viewing and managing user records — EXCEPT roles. The roles
   * column is service-protected: the ONLY write path is the Roles service (permission 'roles'),
   * which also writes the role_grant_event audit row per change. The db doors mirror the
   * service doors: `DbService`'s inner `Db` re-checks the db api as the calling user, so a
   * service-only shape leaves the record surfaces admin-locked (server code proper still uses
   * system paths, which bypass TableAuth).
   */
  auth: Table<User>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
      insert: { permission: USER_PERMISSIONS.users },
      update: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
      insert: { permission: USER_PERMISSIONS.users },
      update: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    },
    /**
     * `roles` is written only by the Roles service; `status` only by the SetUserStatus service
     * (both audited per change — a generic RPC write would let the stored state diverge from its
     * audit trail). `deleteRequestedAt`/`purgeAfter` drive the account purge machinery and are
     * written only by the server-side deletion flow — never through the generic RPC path.
     */
    serviceProtectedColumns: ['roles', 'status', 'deleteRequestedAt', 'purgeAfter'],
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
    avatarEmoji: new StringColumn('avatar_emoji'),
    avatarFileId: new StringColumn('avatar_file_id'),
    status: new StringColumn<UserStatus>('status', { defaultValue: async () => 'active' }, 16),
    deleteRequestedAt: new DateTimeColumn('delete_requested_at'),
    purgeAfter: new DateTimeColumn('purge_after'),
  });
}
