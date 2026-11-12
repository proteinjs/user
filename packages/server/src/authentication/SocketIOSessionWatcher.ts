import { Db, QueryBuilder, Table, TableWatcher } from '@proteinjs/db';
import { Session, SessionTable } from '@proteinjs/user';
import { SocketIOServerRepo } from '@proteinjs/server';

/**
 * Handles Socket.IO session cleanup (such as disconnecting sockets)
 * when sessions are deleted.
 *
 * ONLY FOR A SESSION THAT IS TRULY GONE. A delete made inside a transaction is not a fact until
 * the transaction commits, and never becomes one when it rolls back (or when the driver retries
 * the attempt): the sockets are asked for through the Db the delete hands its hooks
 * (`runAfterCommit`), so the ask runs once the transaction has committed, never on a rollback, and
 * at once for a delete made outside a transaction — a statement that has committed by then. Every
 * session end therefore closes sockets on committed truth, whether its caller ends the sessions
 * after its own write or inside one transaction with it.
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
    deleteQb: QueryBuilder<T>,
    db: Db
  ): Promise<void> {
    const deletedSessionIds = deletedRecords.map((deletedRecord) => deletedRecord.sessionId);
    // No rooms is never sent: socket.io applies an operation with an empty room list to EVERY
    // socket on the namespace.
    if (deletedSessionIds.length === 0) {
      return;
    }

    await db.runAfterCommit(async () => {
      SocketIOServerRepo.getSocketIOServerIfExists()?.in(deletedSessionIds).disconnectSockets(true);
    });
  }
}
