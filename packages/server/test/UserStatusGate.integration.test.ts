import sha256 from 'crypto-js/sha256';
import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { authenticate } from '../src/authentication/authenticate';
import { userCache } from '../src/authorization/userCache';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * The deactivation gate, both halves, asserted on outcomes against the emulator:
 * - login half (authenticate): correct credentials on a deactivated account are refused;
 * - session half (userCache): the session cache is rebuilt per request, so a live session stops
 *   resolving the moment its account is deactivated — requests run as the unauthenticated guest.
 */
describe('user status gate — login refusal and session resolution', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  /** Insert an account the way the product stores it: lowercased email, sha256 password. */
  const createAccount = async (email: string, password: string, status?: 'active' | 'deactivated') => {
    return await getDbAsSystem().insert(tables.User, {
      name: 'Gate test user',
      email,
      password: sha256(password).toString(),
      emailVerified: true,
      roles: [],
      ...(status ? { status } : {}),
    });
  };

  it('refuses login for a deactivated account even with correct credentials', async () => {
    await createAccount('deactivated-login@test.local', 'correct-password', 'deactivated');

    const result = await authenticate('deactivated-login@test.local', 'correct-password');

    expect(result).toBe('This account has been deactivated');
  });

  it('logs an active account in unaffected', async () => {
    await createAccount('active-login@test.local', 'correct-password');

    expect(await authenticate('active-login@test.local', 'correct-password')).toBe(true);
    expect(await authenticate('active-login@test.local', 'wrong-password')).toBe('User name or password incorrect');
  });

  it('stops resolving a live session once its user is deactivated, and resumes on reactivation', async () => {
    const account = await createAccount('live-session@test.local', 'correct-password');

    const before = await userCache.create('live-session', 'live-session@test.local');
    expect(before.id).toBe(account.id);
    expect(before.email).toBe('live-session@test.local');

    await getDbAsSystem().update(tables.User, { id: account.id, status: 'deactivated' });
    const during = await userCache.create('live-session', 'live-session@test.local');
    expect(during.id).toBe('guest');
    expect(during.roles).toEqual([]);

    await getDbAsSystem().update(tables.User, { id: account.id, status: 'active' });
    const after = await userCache.create('live-session', 'live-session@test.local');
    expect(after.id).toBe(account.id);
  });
});
