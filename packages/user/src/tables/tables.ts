import { AccessGrant, AccessGrantTable } from './AccessGrantTable';
import { UserTable, User } from './UserTable';
import { SessionTable, Session } from './SessionTable';
import { Table } from '@proteinjs/db';
import { Invite, InviteTable } from './InviteTable';
import { AccessInvite, AccessInviteTable } from './AccessInviteTable';

export const tables = {
  AccessGrant: new AccessGrantTable() as Table<AccessGrant>,
  AccessInvite: new AccessInviteTable() as Table<AccessInvite>,
  Invite: new InviteTable() as Table<Invite>,
  User: new UserTable() as Table<User>,
  Session: new SessionTable() as Table<Session>,
};
