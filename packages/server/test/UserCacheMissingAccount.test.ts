import { DefaultAdminCredentials } from '../src/authentication/DefaultAdminCredentials';
import { userCache } from '../src/authorization/userCache';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type DefaultAdminCredentialsInternals = { CREDENTIALS: { username: string; password: string } | undefined };

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

  it('a default admin whose name is written with capitals answers as the admin in a session bound in lower case', async () => {
    const credentials = DefaultAdminCredentials as unknown as DefaultAdminCredentialsInternals;
    credentials.CREDENTIALS = { username: 'Admin@Test.Local', password: 'a password' };
    try {
      // The session as the one place a session is made binds it (establishSession): the address in lower case.
      const user = await userCache.create('admin-session', 'admin@test.local');

      expect(user.id).toBe('admin');
      expect(user.roles).toEqual(['admin']);
    } finally {
      credentials.CREDENTIALS = undefined;
    }
  });
});
