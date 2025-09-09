import { QueryBuilder, Table, TableWatcher } from '@proteinjs/db';
import { Session, SessionTable } from '@proteinjs/user';
import { SocketIOServerRepo } from '@proteinjs/server';

/**
 * Handles Socket.IO session cleanup (such as disconnecting sockets)
 * when sessions are deleted.
 */
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
    initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>
  ): Promise<void> {
    const deletedSessionIds = deletedRecords.map((deletedRecord) => deletedRecord.sessionId);
    SocketIOServerRepo.getSocketIOServer().in(deletedSessionIds).disconnectSockets(true);
  }
}
