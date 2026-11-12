import { sha256Hex } from './sha256Hex';
import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { authenticate } from '../src/authentication/authenticate';
import { DefaultAdminCredentials } from '../src/authentication/DefaultAdminCredentials';
import { userCache } from '../src/authorization/userCache';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * The deactivation gate, both halves, asserted on outcomes against the emulator:
 * - login half (authenticate): correct credentials on a deactivated account are refused;
 * - session half (userCache): the session cache is rebuilt per request, so a live session stops
 *   resolving the moment its account is deactivated — requests run as the unauthenticated guest.
 *
 * And the second factor's session half, where a relying party is declared: a session of an account
 * that must use a passkey resolves only when its stored data carries the record of one.
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
      password: sha256Hex(password),
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

  describe('the second factor on every request, with a relying party declared', () => {
    const RELYING_PARTY_KEY = '@proteinjs/user-server/PasskeyRelyingParty';
    const objectCache = () =>
      (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache;
    const switches = { DEVELOPMENT: process.env.DEVELOPMENT, DEV_LOOP_DOORS: process.env.DEV_LOOP_DOORS };

    /** A session row as the store writes one: the bound account, and the second factor's record when it was opened with one. */
    const insertSession = async (
      sessionId: string,
      email: string,
      secondFactor?: Record<string, string>,
      expires = new Date(Date.now() + 60 * 60 * 1000)
    ) =>
      await getDbAsSystem().insert(tables.Session, {
        sessionId,
        session: JSON.stringify({ cookie: {}, passport: { user: email }, ...(secondFactor ? { secondFactor } : {}) }),
        expires,
        userEmail: email,
      });
    const resolvedId = async (sessionId: string, email: string) => (await userCache.create(sessionId, email)).id;

    beforeAll(() => {
      objectCache()[RELYING_PARTY_KEY] = [
        { getRelyingParty: () => ({ id: 'example.test', origin: 'https://app.example.test', name: 'Example' }) },
      ];
      delete process.env.DEVELOPMENT;
      delete process.env.DEV_LOOP_DOORS;
    });

    afterAll(() => {
      objectCache()[RELYING_PARTY_KEY] = [];
      for (const [name, value] of Object.entries(switches)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    it(`a session opened without a passkey stops resolving the moment its account holds an administrative role; one whose stored record names a passkey resolves; a declared machine account's resolves; a session recorded by the development door resolves only while the development switches are set`, async () => {
      const email = 'factor-person@test.local';
      const account = await createAccount(email, 'correct-password');
      const at = '2026-01-02T03:04:05.000Z';
      await insertSession('factor-plain', email);
      await insertSession('factor-passkey', email, { method: 'passkey', passkeyId: 'a-passkey-row', at });
      await insertSession('factor-dev', email, { method: 'dev', at });

      expect(await resolvedId('factor-plain', email)).toBe(account.id);

      await getDbAsSystem().update(tables.User, { id: account.id, roles: ['admin'] });
      expect(await resolvedId('factor-plain', email)).toBe('guest');
      expect(await resolvedId('factor-passkey', email)).toBe(account.id);

      expect(await resolvedId('factor-dev', email)).toBe('guest');
      process.env.DEVELOPMENT = 'true';
      expect(await resolvedId('factor-dev', email)).toBe(account.id);
      expect(await resolvedId('factor-plain', email)).toBe('guest');
      delete process.env.DEVELOPMENT;

      const machine = await getDbAsSystem().insert(tables.User, {
        name: 'Declared machine',
        email: 'factor-machine@test.local',
        password: sha256Hex('a-generated-machine-secret'),
        emailVerified: true,
        roles: ['admin'],
        isLoadedFromSource: true,
        machine: true,
      });
      await insertSession('factor-machine', machine.email);
      expect(await resolvedId('factor-machine', machine.email)).toBe(machine.id);

      // A deployment that declares no relying party has no second factor: the same plain session resolves.
      const declared = objectCache()[RELYING_PARTY_KEY];
      objectCache()[RELYING_PARTY_KEY] = [];
      try {
        expect(await resolvedId('factor-plain', email)).toBe(account.id);
      } finally {
        objectCache()[RELYING_PARTY_KEY] = declared;
      }
    });

    it('a session row that has lapsed is no session, so it carries no record: the account resolves as the guest on it, and as itself on the same row still live; a row the store cannot read fails the request', async () => {
      const email = 'factor-lapsed@test.local';
      const account = await createAccount(email, 'correct-password');
      await getDbAsSystem().update(tables.User, { id: account.id, roles: ['admin'] });
      const record = { method: 'passkey', passkeyId: 'a-passkey-row', at: '2026-01-02T03:04:05.000Z' };
      await insertSession('factor-live', email, record);
      await insertSession('factor-lapsed', email, record, new Date(Date.now() - 60 * 1000));

      expect(await resolvedId('factor-live', email)).toBe(account.id);
      expect(await resolvedId('factor-lapsed', email)).toBe('guest');

      // The store is the one reader of a row's stored form: data it cannot read is its failure,
      // as at its own `get` — never read here as "no record".
      await getDbAsSystem().insert(tables.Session, {
        sessionId: 'factor-unreadable',
        session: 'not a session',
        expires: new Date(Date.now() + 60 * 60 * 1000),
        userEmail: email,
      });
      await expect(userCache.create('factor-unreadable', email)).rejects.toThrow();
    });

    it('the built-in default admin can hold no passkey: its session does not resolve; where no relying party is declared it resolves as the built-in admin — its username declared with a capital, its session bound lowercased as every session is; an account of its own beside it resolves as itself either way', async () => {
      const credentials = DefaultAdminCredentials as unknown as {
        CREDENTIALS?: { username: string; password: string };
      };
      credentials.CREDENTIALS = { username: 'Factor-Default-Admin@Test.local', password: 'a-bootstrap-password' };
      const declared = objectCache()[RELYING_PARTY_KEY];
      try {
        await insertSession('factor-default-admin', 'factor-default-admin@test.local');
        const person = await createAccount('factor-beside-default-admin@test.local', 'correct-password');
        await insertSession('factor-beside-default-admin', person.email);

        expect(await resolvedId('factor-default-admin', 'factor-default-admin@test.local')).toBe('guest');
        expect(await resolvedId('factor-beside-default-admin', person.email)).toBe(person.id);

        objectCache()[RELYING_PARTY_KEY] = [];
        const builtIn = await userCache.create('factor-default-admin', 'factor-default-admin@test.local');
        expect(builtIn.id).toBe('admin');
        expect(builtIn.roles).toEqual(['admin']);
        expect(builtIn.email).toBe('factor-default-admin@test.local');
        expect(await resolvedId('factor-beside-default-admin', person.email)).toBe(person.id);
      } finally {
        objectCache()[RELYING_PARTY_KEY] = declared;
        credentials.CREDENTIALS = undefined;
      }
    });
  });
});
