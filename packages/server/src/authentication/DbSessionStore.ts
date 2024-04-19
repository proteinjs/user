import { Store } from 'express-session';
import { getSystemDb, QueryBuilderFactory } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { destroySession } from './destroySession';

export class DbSessionStore extends Store {
    private static readonly TWELVE_HOURS = 1000 * 60 * 60 * 12;

	constructor() {
        super();
        setInterval(this.sweep, DbSessionStore.TWELVE_HOURS);
	}

	get = (sessionId: string, cb: (error: any, session?: Express.SessionData|null) => void) => {
		(async () => {
            const result = await getSystemDb().get(tables.Session, { sessionId });
            if (!result) {
                cb(null);
                return;
            }

            return cb(null, JSON.parse(result.session));
        })();
	}

	set = (sessionId: string, session: Express.SessionData, cb?: (error?: any) => void) => {
        this.insertOrUpdate(sessionId, session, cb);
    }
    
    touch = (sessionId: string, session: Express.SessionData, cb?: (error?: any) => void) => {
		this.insertOrUpdate(sessionId, session, cb);
    }

    /**
     * Does not get called since request.logout is broken
     * See logout.ts
     */
	destroy = (sessionId: string, cb?: (error?: any) => void) => {
        // console.info('in destroy');
		(async () => {
            await destroySession(sessionId);
            if (cb)
                cb();
        })();
	}

    private async insertOrUpdate(sessionId: string, session: Express.SessionData, cb?: (error?: any) => void): Promise<void> {
        // Only persist authenticated sessions
        if (!session.passport?.user) {
            if (cb)
                cb();

            return;
        }

        const sessionRecord = await getSystemDb().get(tables.Session, { sessionId });
        if (sessionRecord) {
            sessionRecord.session = JSON.stringify(session);
            sessionRecord.expires = (<Date>session.cookie.expires);
            sessionRecord.userEmail = session.passport?.user;
            await getSystemDb().update(tables.Session, sessionRecord, { sessionId });
        } else {
            try {
                await getSystemDb().insert(tables.Session, {
                    sessionId,
                    session: JSON.stringify(session),
                    expires: (<Date>session.cookie.expires),
                    userEmail: session.passport?.user
                });
            } catch (error) {
                // race condition on insert
                console.error('Failed to create session', error);
            }
        }

        if (cb)
            cb();
    }

    private async sweep(): Promise<void> {
        if (!await getSystemDb().tableExists(tables.Session))
            return;

        console.info(`Sweeping expired sessions`);
        const qb = new QueryBuilderFactory().getQueryBuilder(tables.Session)
            .condition({ field: 'expires', operator: '<=', value: new Date() })
        ;
        const deleteCount = await getSystemDb().delete(tables.Session, qb);
		console.info(`Swept ${deleteCount} expired sessions`);
	}
}