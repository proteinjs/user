import { getSystemDb } from '@proteinjs/db';
import { tables } from '@proteinjs/user';

export async function destroySession(sessionId?: string) {
    if (!sessionId)
        return;

    await getSystemDb().delete(tables.Session, { sessionId });
}