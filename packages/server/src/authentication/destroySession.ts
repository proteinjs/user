import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';

export async function destroySession(sessionId?: string) {
  if (!sessionId) {
    return;
  }

  await getDbAsSystem().delete(tables.Session, { sessionId });
}
