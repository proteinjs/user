import sha256 from 'crypto-js/sha256';
import { getDbAsSystem } from '@proteinjs/db';
import { User, tables } from '@proteinjs/user';
import { AccountDeletion } from '../src/services/AccountDeletion';
import { login } from '../src/routes/login';
import { invokeDevLogin } from './devLoginHarness';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const PASSWORD = 'correct-password';
const DEACTIVATED = 'This account has been deactivated';
const PURGING = 'This account is being deleted and can no longer be restored.';

/**
 * Two doors mint a new session: the password login and the development-only `GET /dev/login`.
 * Whether an ACCOUNT may have one is a single rule, asked by both — a deactivated account is
 * refused; an account deactivated by its own pending deletion is admitted, because coming back IS
 * the cancel, and the restore runs before the session so the first authenticated request sees a
 * whole account; an account already being purged is refused. Outcomes only, against the emulator:
 * the session each door minted (or not), what it answered, the account's row afterwards.
 *
 * The dev door used to skip the rule: it signed a deactivated account in, and every request on
 * that session then resolved as the guest — a session that looked established and could do nothing.
 */
describe('a new session is admitted by one rule at both doors', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
    DEV_BOOTSTRAP_ADMIN_EMAIL: process.env.DEV_BOOTSTRAP_ADMIN_EMAIL,
    DEV_BOOTSTRAP_ROLES: process.env.DEV_BOOTSTRAP_ROLES,
  };
  let account: User;

  beforeAll(async () => {
    await testEnv.beforeAll();
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = 'dev@test.local';
    delete process.env.DEV_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.DEV_BOOTSTRAP_ROLES;

    const db = getDbAsSystem();
    await db.delete(tables.AccountDeletion, {});
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.Session, {});
    await db.delete(tables.UserStatusEvent, {});
    await db.delete(tables.User, {});
    account = await db.insert(tables.User, {
      name: 'Admission test user',
      email: 'returning@test.local',
      password: sha256(PASSWORD).toString(),
      emailVerified: true,
      roles: [],
    });
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

  const accountRow = async () => await getDbAsSystem().get(tables.User, { id: account.id });
  const deletionRow = async () => await getDbAsSystem().get(tables.AccountDeletion, { userId: account.id });

  const deactivate = async () => await getDbAsSystem().update(tables.User, { id: account.id, status: 'deactivated' });

  const requestDeletion = async () => {
    testEnv.actAs(account);
    await new AccountDeletion().requestDeletion(PASSWORD);
  };

  const invokeLogin = async () => {
    let sent: any;
    const response: any = {
      send: (body: any) => {
        sent = body;
      },
      status: () => response,
    };
    const { request } = await createPassportRequest({ body: { email: account.email, password: PASSWORD } });
    await login.onRequest(request, response);
    return { loggedInAs: request.session.passport?.user as string | undefined, sent };
  };

  describe('the development door (GET /dev/login)', () => {
    it('refuses a deactivated account: no session, no redirect, the rule’s own sentence', async () => {
      await deactivate();

      const outcome = await invokeDevLogin({ email: account.email });

      expect(outcome.loggedInAs).toBeUndefined();
      expect(outcome.sessionSaved).toBe(false);
      expect(outcome.redirect).toBeUndefined();
      expect(outcome.status).toBe(403);
      expect(outcome.body).toBe(DEACTIVATED);
      expect((await accountRow()).status).toBe('deactivated');
    });

    it('admits an account whose deactivation is its own pending deletion — restored BEFORE the session', async () => {
      await requestDeletion();
      expect((await accountRow()).status).toBe('deactivated');

      const outcome = await invokeDevLogin({ email: account.email });

      expect(outcome.loggedInAs).toBe(account.email);
      expect(outcome.redirect).toBe('/');
      expect((await accountRow()).status).toBe('active');
      expect(await deletionRow()).toBeFalsy();
    });

    it('refuses an account already being purged', async () => {
      await requestDeletion();
      const deletion = await deletionRow();
      await getDbAsSystem().update(tables.AccountDeletion, { id: deletion.id, phase: 'purging' });

      const outcome = await invokeDevLogin({ email: account.email });

      expect(outcome.loggedInAs).toBeUndefined();
      expect(outcome.redirect).toBeUndefined();
      expect(outcome.status).toBe(403);
      expect(outcome.body).toBe(PURGING);
      expect((await accountRow()).status).toBe('deactivated');
    });

    it('an active account signs in as before', async () => {
      const outcome = await invokeDevLogin({ email: account.email });

      expect(outcome.loggedInAs).toBe(account.email);
      expect(outcome.redirect).toBe('/');
    });
  });

  describe('the password door (login)', () => {
    it('refuses a deactivated account with the same sentence the development door gives', async () => {
      await deactivate();

      const { loggedInAs, sent } = await invokeLogin();

      expect(loggedInAs).toBeUndefined();
      expect(sent).toEqual({ error: DEACTIVATED });
    });

    it('admits a pending deletion — restored before the session', async () => {
      await requestDeletion();

      const { loggedInAs, sent } = await invokeLogin();

      expect(sent).toEqual({});
      expect(loggedInAs).toBe(account.email);
      expect((await accountRow()).status).toBe('active');
      expect(await deletionRow()).toBeFalsy();
    });

    it('refuses an account already being purged', async () => {
      await requestDeletion();
      const deletion = await deletionRow();
      await getDbAsSystem().update(tables.AccountDeletion, { id: deletion.id, phase: 'purging' });

      const { loggedInAs, sent } = await invokeLogin();

      expect(loggedInAs).toBeUndefined();
      expect(sent).toEqual({ error: PURGING });
    });
  });
});
