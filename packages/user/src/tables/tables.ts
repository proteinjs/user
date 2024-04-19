import { UserTable, User } from './UserTable';
import { SessionTable, Session } from './SessionTable';
import { Table } from '@proteinjs/db';

export const tables = {
  User: new UserTable() as Table<User>,
  Session: new SessionTable() as Table<Session>,
}