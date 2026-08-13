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
    invitedBy: new StringColumn('invited_by'),
    avatarEmoji: new StringColumn('avatar_emoji'),
    avatarFileId: new StringColumn('avatar_file_id'),
  });
}
