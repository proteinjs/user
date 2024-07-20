import { QueryBuilder, Table, TableWatcher } from '@proteinjs/db';
import { Session, SessionTable } from '@proteinjs/user';
import { io } from '@proteinjs/server';

export class SocketIOSessionWatcher implements TableWatcher<Session> {
  name(): string {
    return this.constructor.name;
  }

  table(): Table<Session> {
    return new SessionTable();
  }

  async afterDelete<T extends Session>(
    recordDeleteCount: number,
    deletedRecords: T[],
    qb: QueryBuilder<T>
  ): Promise<void> {
    const deletedSessionIds = deletedRecords.map((deletedRecord) => deletedRecord.sessionId);
    io.in(deletedSessionIds).disconnectSockets(true);
  }
}
