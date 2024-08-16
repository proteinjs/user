import { Store } from 'express-session';
import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { destroySession } from './destroySession';

export class DbSessionStore extends Store {
  private static readonly TWELVE_HOURS = 1000 * 60 * 60 * 12;
  private logger = new Logger({ name: this.constructor.name });

  constructor() {
    super();
    setInterval(this.sweep.bind(this), DbSessionStore.TWELVE_HOURS);
  }

  get = (sessionId: string, cb: (error: any, session?: Express.SessionData | null) => void) => {
    (async () => {
      const result = await getDbAsSystem().get(tables.Session, { sessionId });
      if (!result) {
        cb(null);
        return;
      }

      return cb(null, JSON.parse(result.session));
    })();
  };

  set = (sessionId: string, session: Express.SessionData, cb?: (error?: any) => void) => {
    this.insertOrUpdate(sessionId, session, cb);
  };

  touch = (sessionId: string, session: Express.SessionData, cb?: (error?: any) => void) => {
    this.insertOrUpdate(sessionId, session, cb);
  };

  /**
   * Does not get called since request.logout is broken
   * See logout.ts
   */
  destroy = (sessionId: string, cb?: (error?: any) => void) => {
    (async () => {
      await destroySession(sessionId);
      if (cb) {
        cb();
      }
    })();
  };

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
      try {
        sessionRecord.session = JSON.stringify(session);
        sessionRecord.expires = <Date>session.cookie.expires;
        sessionRecord.userEmail = session.passport?.user;
        await getDbAsSystem().update(tables.Session, sessionRecord, { sessionId });
      } catch (error: any) {
        this.logger.error({ message: 'Failed to update session', error });
      }
    } else {
      try {
        await getDbAsSystem().insert(tables.Session, {
          sessionId,
          session: JSON.stringify(session),
          expires: <Date>session.cookie.expires,
          userEmail: session.passport?.user,
        });
      } catch (error: any) {
        // race condition on insert
        this.logger.error({ message: 'Failed to create session', error });
      }
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
