import { getDbAsSystem } from '@proteinjs/db';
import { tables, type UserActivity } from '@proteinjs/user';
import { userCache } from '../src/authorization/userCache';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const activityRows = async (scope: string): Promise<UserActivity[]> =>
  await getDbAsSystem().query(tables.UserActivity, { scope });

/**
 * TRANSPORT IS NOT PRESENCE (UserActivityTable's contract; founder finding 2026-09-12 — every
 * user on the admin usage page "last active today"). The per-request session-cache build
 * (`userCache.create`) runs for EVERY request that rides a session cookie: an open tab's polls,
 * a socket's room re-joins on every reconnect, the reload a deploy pushes onto every idle tab.
 * None of that is a person. The build must therefore never write the presence stamp — the
 * only door is the page's human-input report (UserPresence.recordPresence).
 *
 * Pre-fix, `userCache.create` stamped on every build: this test reads one row where the
 * contract says none.
 */
describe('userCache.create — the session build does not stamp presence', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('resolving a human session (any request over a session cookie) writes NO user_activity row', async () => {
    const user = await testEnv.createUser({ name: 'Idle Tab', email: 'idle-tab@test.local' });

    // Three request-shaped builds: a poll, a reconnect re-join, a deploy reload — all the same seam.
    for (const sessionId of ['poll', 'socket-rejoin', 'deploy-reload']) {
      const resolved = await userCache.create(sessionId, user.email);
      expect(resolved.id).toBe(user.id);
    }
    // The pre-fix stamp was fire-and-forget off the build — give it every chance to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await activityRows(user.id)).toHaveLength(0);
  });
});
