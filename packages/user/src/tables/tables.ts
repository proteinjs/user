import { AccessGrant, AccessGrantTable } from './AccessGrantTable';
import { UserTable, User } from './UserTable';
import { SessionTable, Session } from './SessionTable';
import { Table } from '@proteinjs/db';
import { AccountDeletion, AccountDeletionTable } from './AccountDeletionTable';
import { Invite, InviteTable } from './InviteTable';
import { AccessInvite, AccessInviteTable } from './AccessInviteTable';
import { RoleGrantEvent, RoleGrantEventTable } from './RoleGrantEventTable';
import { UserStatusEvent, UserStatusEventTable } from './UserStatusEventTable';
import { UserActivity, UserActivityTable } from './UserActivityTable';
import { UserAccountEvent, UserAccountEventTable } from './UserAccountEventTable';
import { UserPasskey, UserPasskeyTable } from './UserPasskeyTable';
import { AuthChallenge, AuthChallengeTable } from './AuthChallengeTable';

export const tables = {
  AccessGrant: new AccessGrantTable() as Table<AccessGrant>,
  AccessInvite: new AccessInviteTable() as Table<AccessInvite>,
  AccountDeletion: new AccountDeletionTable() as Table<AccountDeletion>,
  AuthChallenge: new AuthChallengeTable() as Table<AuthChallenge>,
  Invite: new InviteTable() as Table<Invite>,
  RoleGrantEvent: new RoleGrantEventTable() as Table<RoleGrantEvent>,
  User: new UserTable() as Table<User>,
  UserAccountEvent: new UserAccountEventTable() as Table<UserAccountEvent>,
  UserActivity: new UserActivityTable() as Table<UserActivity>,
  UserPasskey: new UserPasskeyTable() as Table<UserPasskey>,
  UserStatusEvent: new UserStatusEventTable() as Table<UserStatusEvent>,
  Session: new SessionTable() as Table<Session>,
};
