import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { invokeDevLogin } from './devLoginHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * `GET /dev/login` multi-user dev bootstrap. The route mints a session for the account named by
 * `?email=` (absent → `DEV_AUTO_LOGIN_EMAIL`), auto-creating a missing account through the normal
 * signup creation path (`Signup.createAccount`) so parallel agent-driven verification can
 * self-serve distinct users. Two rails under test:
 * - Double gate: `DEVELOPMENT` AND `DEV_AUTO_LOGIN_EMAIL` both present, else 404 (unchanged).
 * - Domain rail: a `?email=` param must share `DEV_AUTO_LOGIN_EMAIL`'s domain — even a dev server
 *   must not mint sessions (much less accounts) for arbitrary domains. Others 400.
 * The first-admin door (`DEV_BOOTSTRAP_ADMIN_EMAIL`) has its own suite, DevLoginBootstrapAdmin.test.ts;
 * here the variable is unset, so every created account is role-less.
 */

const ENV_EMAIL = 'dev@test.local';

const getUserRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });

describe('devLogin route', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
    DEV_BOOTSTRAP_ADMIN_EMAIL: process.env.DEV_BOOTSTRAP_ADMIN_EMAIL,
  };

  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(() => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = ENV_EMAIL;
    delete process.env.DEV_BOOTSTRAP_ADMIN_EMAIL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('pins the default path: no ?email → session for DEV_AUTO_LOGIN_EMAIL, redirect to /', async () => {
    await testEnv.createUser({ name: 'Dev Default', email: ENV_EMAIL });

    const outcome = await invokeDevLogin();

    expect(outcome.loggedInAs).toBe(ENV_EMAIL);
    expect(outcome.sessionRegenerated).toBe(true); // fresh id on privilege change (fixation)
    expect(outcome.sessionSaved).toBe(true);
    expect(outcome.redirect).toBe('/');
    expect(outcome.status).toBeUndefined();
  });

  it('?email selects an existing same-domain account for the session', async () => {
    await testEnv.createUser({ name: 'Agent Two', email: 'agent2@test.local' });

    const outcome = await invokeDevLogin({ email: 'agent2@test.local' });

    expect(outcome.loggedInAs).toBe('agent2@test.local');
    expect(outcome.sessionSaved).toBe(true);
    expect(outcome.redirect).toBe('/');
  });

  it('?email for a nonexistent same-domain account creates it as a normal test user, then logs in', async () => {
    expect(await getUserRow('agent3@test.local')).toBeUndefined();

    const outcome = await invokeDevLogin({ email: 'agent3@test.local' });

    expect(outcome.loggedInAs).toBe('agent3@test.local');
    expect(outcome.sessionSaved).toBe(true);
    expect(outcome.redirect).toBe('/');

    // Created through the normal signup creation path: argon2id-hashed 'test' password (the
    // seeded test-user convention — interactive login with password 'test' works too), no roles.
    const created = await getUserRow('agent3@test.local');
    expect(created).toBeDefined();
    expect(created!.password.startsWith('$argon2id$')).toBe(true);
    expect(await new PasswordHasher().verify(created!.password, 'test')).toBe(true);
    expect(created!.roles).toEqual([]);
    expect(created!.name).toBeTruthy();
  });

  it('rejects a ?email outside the DEV_AUTO_LOGIN_EMAIL domain with 400 — no session, no account', async () => {
    const outcome = await invokeDevLogin({ email: 'intruder@evil.example' });

    expect(outcome.status).toBe(400);
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionSaved).toBe(false);
    expect(outcome.redirect).toBeUndefined();
    expect(await getUserRow('intruder@evil.example')).toBeUndefined();
  });

  it('rejects a malformed same-domain ?email with 400 — no session, no stray account', async () => {
    // The observed shape: an unencoded `+` in the query decodes to a space, so
    // `?email=brent+shareproof-a@...` arrived as `brent shareproof-a@...` and minted a stray
    // account. The domain rail alone let it through (the domain half was fine).
    const malformed = 'brent shareproof-a@test.local';

    const outcome = await invokeDevLogin({ email: malformed });

    expect(outcome.status).toBe(400);
    expect(String(outcome.body)).toMatch(/not a valid email/i);
    expect(String(outcome.body)).toMatch(/%2B/); // the remedy: percent-encode the `+`
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionSaved).toBe(false);
    expect(outcome.redirect).toBeUndefined();
    expect(await getUserRow(malformed)).toBeUndefined();
  });

  it('still accepts a plus-addressed ?email once it is encoded (the fan-out convention)', async () => {
    const outcome = await invokeDevLogin({ email: 'agent6+lane-a@test.local' });

    expect(outcome.loggedInAs).toBe('agent6+lane-a@test.local');
    expect(outcome.sessionSaved).toBe(true);
    expect(outcome.redirect).toBe('/');
    expect(await getUserRow('agent6+lane-a@test.local')).toBeDefined();
  });

  it('404s when DEVELOPMENT is unset, even with a ?email', async () => {
    delete process.env.DEVELOPMENT;

    const outcome = await invokeDevLogin({ email: 'agent4@test.local' });

    expect(outcome.status).toBe(404);
    expect(outcome.loggedInAs).toBeUndefined();
    expect(await getUserRow('agent4@test.local')).toBeUndefined();
  });

  it('404s when DEV_AUTO_LOGIN_EMAIL is unset, even with a ?email', async () => {
    delete process.env.DEV_AUTO_LOGIN_EMAIL;

    const outcome = await invokeDevLogin({ email: 'agent5@test.local' });

    expect(outcome.status).toBe(404);
    expect(outcome.loggedInAs).toBeUndefined();
    expect(await getUserRow('agent5@test.local')).toBeUndefined();
  });
});
