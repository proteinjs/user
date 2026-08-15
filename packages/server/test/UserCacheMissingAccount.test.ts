import { userCache } from '../src/authorization/userCache';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * Missing-account session crash, red-before-green: a session can outlive its account (user row
 * deleted, or a dev auto-login for a never-created email). userCache.create looked the user up
 * and unconditionally `delete`d the password off the result — `db.get` returns undefined for a
 * missing row, the delete threw, and the rejection escaped wrapRoute's session-cache build
 * (outside its try/catch) as an unhandled rejection that downed the whole process.
 *
 * The seam: userCache.create resolves a missing account to the unauthenticated guest session —
 * the client sees no authenticated user and re-logs — never a throw.
 */
describe('userCache.create — session referencing a missing account', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('resolves to the unauthenticated guest session instead of throwing', async () => {
    // No user row exists for this email — the session simply still names it.
    const user = await userCache.create('stale-session', 'deleted-account@test.local');

    expect(user.id).toBe('guest');
    expect(user.roles).toEqual([]);
  });

  it('still resolves a real account normally', async () => {
    const created = await testEnv.createUser({ name: 'Real User', email: 'real-account@test.local' });

    const user = await userCache.create('live-session', 'real-account@test.local');

    expect(user.id).toBe(created.id);
    expect(user.email).toBe('real-account@test.local');
    expect((user as any).password).toBeUndefined();
  });
});
