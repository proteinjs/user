import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { devLogin } from '../src/routes/devLogin';
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
 */

const ENV_EMAIL = 'dev@test.local';

type RouteOutcome = {
  loggedInAs?: string;
  sessionRegenerated: boolean;
  sessionSaved: boolean;
  status?: number;
  body?: unknown;
  redirect?: string;
};

const invokeDevLogin = async (query?: Record<string, unknown>): Promise<RouteOutcome> => {
  const outcome: RouteOutcome = { sessionRegenerated: false, sessionSaved: false };
  const request = {
    query,
    login: (email: string, done: () => void) => {
      outcome.loggedInAs = email;
      done();
    },
    session: {
      // establishSession's full contract (regenerate → login → save); ordering is pinned by
      // SignupRoute.test.ts — here we assert the dev door INHERITS it.
      regenerate: (done: () => void) => {
        outcome.sessionRegenerated = true;
        done();
      },
      save: (done: () => void) => {
        outcome.sessionSaved = true;
        done();
      },
    },
  };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body;
    },
    redirect(path: string) {
      outcome.redirect = path;
    },
  };
  await devLogin.onRequest(request as never, response as never);
  return outcome;
};

const getUserRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });

describe('devLogin route', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
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
