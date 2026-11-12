import { createServer } from 'http';
import { Db, DbDriver, QueryBuilder } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SourceRepository } from '@proteinjs/reflection';
import { SocketIOServerRepo } from '@proteinjs/server';
import { Session } from '@proteinjs/user';
import { SocketIOSessionWatcher } from '../src/authentication/SocketIOSessionWatcher';

type ObjectCache = { objectCache: Record<string, unknown[]> };

/** What the watcher asked the socket server to do: which rooms (session ids) it closed. */
type DisconnectCall = { rooms: string[]; close: boolean };

/**
 * The socket server this file installs through the repo's own factory seam — a stand-in that
 * records every `in(rooms).disconnectSockets(close)` it receives (no socket.io client is part of
 * this package, so no real socket can connect to observe).
 */
class RecordingSocketIOServer {
  readonly calls: DisconnectCall[] = [];

  in(rooms: string | string[]) {
    return {
      disconnectSockets: (close: boolean) => {
        this.calls.push({ rooms: ([] as string[]).concat(rooms), close });
      },
    };
  }
}

const session = (sessionId: string): Session =>
  ({ id: `row-${sessionId}`, sessionId, session: '{}', userEmail: 'someone@test.local' }) as unknown as Session;

/**
 * The Db a delete hands its hooks, over a driver no statement here reaches and the real
 * transaction context: these deletions are made outside a transaction, where its post-commit
 * queue runs a hook at once. (What a transaction's rollback and commit do to the ask is pinned
 * against the database, with the passkey acts that end sessions inside one:
 * UserAccountAdmin.integration.)
 */
const hookDb = () => new Db({ getDbName: () => 'none' } as unknown as DbDriver, undefined, new TransactionContext());

const deleteSessions = async (sessions: Session[]) =>
  await new SocketIOSessionWatcher().afterDelete(
    sessions.length,
    sessions,
    new QueryBuilder<Session>('session'),
    new QueryBuilder<Session>('session'),
    hookDb()
  );

/**
 * Deleting session rows closes their sockets — and a deletion is not always made by a running
 * server: a boot's source-record sync (and a migration Job, which never starts one) deactivates a
 * withdrawn machine account and deletes its sessions before any socket server exists.
 */
describe('SocketIOSessionWatcher', () => {
  it('a deletion before the socket server exists resolves — no socket can be open yet', async () => {
    expect(SocketIOServerRepo.getSocketIOServerIfExists()).toBeUndefined();

    await expect(deleteSessions([session('before-boot')])).resolves.toBeUndefined();
  });

  describe('with the socket server up', () => {
    const server = new RecordingSocketIOServer();

    beforeAll(async () => {
      (SourceRepository.get() as unknown as ObjectCache).objectCache['@proteinjs/event/DefaultSocketIOServerFactory'] =
        [{ createSocketIOServer: async () => server }];
      await SocketIOServerRepo.createSocketIOServer(createServer());
    });

    afterAll(() => {
      delete (SourceRepository.get() as unknown as ObjectCache).objectCache[
        '@proteinjs/event/DefaultSocketIOServerFactory'
      ];
    });

    beforeEach(() => {
      server.calls.length = 0;
    });

    it(`closes exactly the deleted sessions' sockets`, async () => {
      await deleteSessions([session('s-1'), session('s-2')]);

      expect(server.calls).toEqual([{ rooms: ['s-1', 's-2'], close: true }]);
    });

    it('a deletion with no session ids closes nothing — an empty room list would address every socket', async () => {
      // socket.io's in-memory adapter applies an operation with NO rooms to every socket on the
      // namespace (`apply`: `if (rooms.size) … else for every sid`), so `in([])` must never be sent.
      await deleteSessions([]);

      expect(server.calls).toEqual([]);
    });
  });
});
