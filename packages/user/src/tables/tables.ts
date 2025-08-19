import { AccessGrant, AccessGrantTable } from './AccessGrantTable';
import { UserTable, User } from './UserTable';
import { SessionTable, Session } from './SessionTable';
import { Table } from '@proteinjs/db';
import { Invite, InviteTable } from './InviteTable';

export const tables = {
  AccessGrant: new AccessGrantTable() as Table<AccessGrant>,
  Invite: new InviteTable() as Table<Invite>,
  User: new UserTable() as Table<User>,
  Session: new SessionTable() as Table<Session>,
};
