import { Store } from 'express-session';
import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { destroySession } from './destroySession';

export class DbSessionStore extends Store {
  private static readonly TWELVE_HOURS = 1000 * 60 * 60 * 12;
  /** Touch at most this often per session — every SPA request otherwise rewrites the same row
   *  and parallel requests wound each other's Spanner transactions. */
  private static readonly TOUCH_INTERVAL = 1000 * 60 * 5;
  private logger = new Logger({ name: this.constructor.name });
  private lastTouchMs = new Map<string, number>();
  /**
   * The sessions that have a row behind them: each one loaded from its row (`createSession`), and each one
   * whose row this store has written or found (`insertOrUpdate`). Held by the session object itself, which
   * lives as long as its request does.
   */
  private rowBehind = new WeakSet<object>();

  constructor() {
    super();
    // The store is the async→callback boundary: every promise here must land in the request's
    // callback (or a log), never float — a floating rejection (e.g. a transient Spanner timeout
    // after host sleep) is fatal under Node's default unhandled-rejection policy and took the
    // dev server down (2026-07-25).
    setInterval(
      () => void this.sweep().catch((error) => this.logger.error({ message: 'Failed to sweep sessions', error })),
      DbSessionStore.TWELVE_HOURS
    );
  }

  get = (sessionId: string, cb: (error: any, session?: Express.SessionData | null) => void) => {
    (async () => {
      const result = await getDbAsSystem().get(tables.Session, { sessionId });
      if (!result) {
        cb(null);
        return;
      }

      return cb(null, JSON.parse(result.session));
    })().catch((error) => cb(error));
  };

  set = (sessionId: string, session: Express.SessionData, cb?: (error?: any) => void) => {
    this.insertOrUpdate(sessionId, session, cb).catch(async (error) => {
      // A wounded transaction (concurrent request won the row) is retryable, not fatal — one
      // aborted session write must never 500 the request that carried it.
      if (DbSessionStore.isTransactionAbort(error)) {
        try {
          await this.insertOrUpdate(sessionId, session, cb);
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      this.logger.error({ message: 'Failed to persist session', error });
      if (cb) {
        cb(error);
      }
    });
  };

  touch = (sessionId: string, session: Express.SessionData, cb?: (error?: any) => void) => {
    // Rolling-expiry touch fires on EVERY request; rewriting the row each time makes parallel
    // requests wound each other ("aborted ... conflict on session_id" storms — the session-drop
    // plague's server face). Throttle per session; a lost touch only delays expiry refresh.
    const last = this.lastTouchMs.get(sessionId) ?? 0;
    const now = Date.now();
    if (now - last < DbSessionStore.TOUCH_INTERVAL) {
      if (cb) {
        cb();
      }
      return;
    }
    this.lastTouchMs.set(sessionId, now);
    if (this.lastTouchMs.size > 10000) {
      this.lastTouchMs.clear(); // bounded memory; worst case is one extra touch per session
    }
    this.insertOrUpdate(sessionId, session, cb).catch((error) => {
      if (DbSessionStore.isTransactionAbort(error)) {
        // Benign: a concurrent request's write already refreshed this session row.
        if (cb) {
          cb();
        }
        return;
      }
      this.lastTouchMs.delete(sessionId);
      this.logger.error({ message: 'Failed to persist session', error });
      if (cb) {
        cb(error);
      }
    });
  };

  /** Spanner ABORTED / wounded-transaction shape (transient by definition). */
  private static isTransactionAbort(error: any): boolean {
    const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.errorDetails ?? ''}`;
    return error?.code === 10 || /aborted|wounded/i.test(text);
  }

  /**
   * Called by express-session with what `get` answered, to make the request's session of it: a session
   * that has a row behind it.
   */
  createSession = (request: any, session: Express.SessionData) => {
    const loaded: object = (Store.prototype.createSession as (...args: unknown[]) => object).call(
      this,
      request,
      session
    );
    this.rowBehind.add(loaded);
    return loaded;
  };

  /**
   * Called by express-session whenever a session id is retired — most notably from
   * `session.regenerate` inside passport's login (fixation rotation) and logout (see logout.ts):
   * the old id's row is deleted, which also disconnects its sockets (SocketIOSessionWatcher).
   */
  destroy = (sessionId: string, cb?: (error?: any) => void) => {
    (async () => {
      await destroySession(sessionId);
      if (cb) {
        cb();
      }
    })().catch((error) => {
      if (cb) {
        cb(error);
      }
    });
  };

  /**
   * A SESSION'S ROW IS WRITTEN ONCE: by the first save of a session that has no row behind it, which is
   * the save passport makes of the session a log-in has just made (`establishSession`). A session that
   * was loaded from its row, or whose row this store has written, is only ever updated. So a session
   * that is ended while one of its requests is at work (its row deleted: a log-out in another tab,
   * whatever ends an account's sessions) stays ended: that request's own save or touch at its end
   * updates nothing and writes no row. A first write that fails is its save's failure: `set` makes a
   * wounded one again, once, and otherwise tells the save's caller, and `establishSession` ends the
   * session it could not save.
   */
  private async insertOrUpdate(
    sessionId: string,
    session: Express.SessionData,
    cb?: (error?: any) => void
  ): Promise<void> {
    // Only persist authenticated sessions
    if (!session.passport?.user) {
      if (cb) {
        cb();
      }

      return;
    }

    const sessionRecord = await getDbAsSystem().get(tables.Session, { sessionId });
    if (sessionRecord) {
      this.rowBehind.add(session);
      try {
        sessionRecord.session = JSON.stringify(session);
        sessionRecord.expires = <Date>session.cookie.expires;
        sessionRecord.userEmail = session.passport?.user;
        await getDbAsSystem().update(tables.Session, sessionRecord, { sessionId });
      } catch (error: any) {
        this.logger.error({ message: 'Failed to update session', error });
      }
    } else if (!this.rowBehind.has(session)) {
      await getDbAsSystem().insert(tables.Session, {
        sessionId,
        session: JSON.stringify(session),
        expires: <Date>session.cookie.expires,
        userEmail: session.passport?.user,
      });
      this.rowBehind.add(session);
    }

    if (cb) {
      cb();
    }
  }

  private async sweep(): Promise<void> {
    if (!(await getDbAsSystem().tableExists(tables.Session))) {
      return;
    }

    this.logger.info({ message: `Sweeping expired sessions` });
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(tables.Session)
      .condition({ field: 'expires', operator: '<=', value: new Date() });
    const deleteCount = await getDbAsSystem().delete(tables.Session, qb);
    this.logger.info({ message: `Finished sweeping expired sessions`, obj: { deleteCount } });
  }
}
