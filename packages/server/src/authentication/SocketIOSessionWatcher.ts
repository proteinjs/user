import { QueryBuilder, Table, TableWatcher } from '@proteinjs/db';
import { Session, SessionTable } from '@proteinjs/user';
import { SocketIOServerRepo } from '@proteinjs/server';

/**
 * Handles Socket.IO session cleanup (such as disconnecting sockets)
 * when sessions are deleted.
 *
 * A deletion is not always made by a running server: a boot's source-record sync — and a
 * migration Job, which never starts one — deactivates a withdrawn machine account and deletes its
 * sessions before any socket server exists. Then no socket can be open, and there is nothing to
 * close.
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
    const socketIOServer = SocketIOServerRepo.getSocketIOServerIfExists();
    const deletedSessionIds = deletedRecords.map((deletedRecord) => deletedRecord.sessionId);
    // No rooms is never sent: socket.io applies an operation with an empty room list to EVERY
    // socket on the namespace.
    if (!socketIOServer || deletedSessionIds.length === 0) {
      return;
    }

    socketIOServer.in(deletedSessionIds).disconnectSockets(true);
  }
}
