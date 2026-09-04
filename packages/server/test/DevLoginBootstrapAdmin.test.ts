import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { invokeDevLogin } from './devLoginHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * `DEV_BOOTSTRAP_ADMIN_EMAIL` — the first-admin door INSIDE `/dev/login` (n3xa plans/DEV_ESTATES.md
 * D3, founder-ruled 2026-09-04). A dev estate on a fresh real database has no privileged account
 * to grant from, and the no-raw-DB rule forbids the emulator-era seed scripts there — so the ONE
 * sanctioned account door mints break-glass, once:
 *  - behind the door's existing two gates (DEVELOPMENT AND DEV_AUTO_LOGIN_EMAIL): closed = 404 as
 *    before, and the variable changes nothing;
 *  - only while NO account carries 'admin' (the same membership test the app's admin checks make);
 *  - only for the request whose resolved address equals the variable exactly (case-normalized
 *    the way every account email is);
 *  - once, audited like any grant (a role_grant_event row; actor = the account itself — the door
 *    acts for nobody else); a later call finds an admin and grants nothing.
 * Outcomes are asserted on the rows (roles, audit), never on calls.
 */

const ENV_EMAIL = 'dev@test.local';
const BOOTSTRAP_EMAIL = 'owner@test.local';

const userRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });
const auditRows = async () => await getDbAsSystem().query(tables.RoleGrantEvent, {});
const adminRows = async () =>
  (await getDbAsSystem().query(tables.User, {})).filter((user) => (user.roles ?? []).includes('admin'));

describe('devLogin — the DEV_BOOTSTRAP_ADMIN_EMAIL first-admin door', () => {
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

  beforeEach(async () => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = ENV_EMAIL;
    process.env.DEV_BOOTSTRAP_ADMIN_EMAIL = BOOTSTRAP_EMAIL;
    // Every case starts from a fresh database: no accounts, no audit trail.
    const db = getDbAsSystem();
    await db.delete(tables.RoleGrantEvent, {});
    await db.delete(tables.User, {});
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

  it('a fresh database + the matching address: the account is created carrying admin, audited once, and logged in', async () => {
    expect(await userRow(BOOTSTRAP_EMAIL)).toBeUndefined();

    const outcome = await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

    expect(outcome.loggedInAs).toBe(BOOTSTRAP_EMAIL);
    expect(outcome.sessionSaved).toBe(true);
    expect(outcome.redirect).toBe('/');
    const owner = await userRow(BOOTSTRAP_EMAIL);
    expect(owner!.roles).toEqual(['admin']);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: owner!.id, target: owner!.id, role: 'admin', action: 'grant' });
    expect(await adminRows()).toHaveLength(1);
  });

  it('a second call for the same address changes nothing: still exactly one admin, one grant', async () => {
    await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

    const outcome = await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

    expect(outcome.loggedInAs).toBe(BOOTSTRAP_EMAIL);
    expect((await userRow(BOOTSTRAP_EMAIL))!.roles).toEqual(['admin']);
    expect(await auditRows()).toHaveLength(1);
    expect(await adminRows()).toHaveLength(1);
  });

  it('an existing role-less account at the matching address is granted admin on its next login — the door serves created and loaded accounts alike', async () => {
    await testEnv.createUser({ name: 'Owner', email: BOOTSTRAP_EMAIL });

    const outcome = await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

    expect(outcome.loggedInAs).toBe(BOOTSTRAP_EMAIL);
    expect((await userRow(BOOTSTRAP_EMAIL))!.roles).toEqual(['admin']);
    expect(await auditRows()).toHaveLength(1);
  });

  it('the default path is a request for DEV_AUTO_LOGIN_EMAIL: when that IS the bootstrap address, the default account carries admin', async () => {
    process.env.DEV_BOOTSTRAP_ADMIN_EMAIL = ENV_EMAIL;

    const outcome = await invokeDevLogin();

    expect(outcome.loggedInAs).toBe(ENV_EMAIL);
    expect((await userRow(ENV_EMAIL))!.roles).toEqual(['admin']);
    expect(await auditRows()).toHaveLength(1);
  });

  it('the match is case-normalized like every account email — never a second account for a differently-cased address', async () => {
    process.env.DEV_BOOTSTRAP_ADMIN_EMAIL = 'Owner@Test.local';

    await invokeDevLogin({ email: 'owner@test.local' });

    expect((await userRow(BOOTSTRAP_EMAIL))!.roles).toEqual(['admin']);
    expect(await adminRows()).toHaveLength(1);
  });

  it('an admin already exists: the matching address gets an ordinary account — no grant, no audit row', async () => {
    await testEnv.createUser({ name: 'Standing admin', email: 'standing-admin@test.local', roles: ['admin'] });

    const outcome = await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

    expect(outcome.loggedInAs).toBe(BOOTSTRAP_EMAIL);
    expect((await userRow(BOOTSTRAP_EMAIL))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect((await adminRows()).map((user) => user.email)).toEqual(['standing-admin@test.local']);
  });

  it('a different same-domain address: an ordinary account, no grant — and the bootstrap address itself stays uncreated', async () => {
    const outcome = await invokeDevLogin({ email: 'agent@test.local' });

    expect(outcome.loggedInAs).toBe('agent@test.local');
    expect((await userRow('agent@test.local'))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(await userRow(BOOTSTRAP_EMAIL)).toBeUndefined();
    expect(await adminRows()).toHaveLength(0);
  });

  it('the address must match exactly — a plus-suffixed variant is a different account and gets nothing', async () => {
    const outcome = await invokeDevLogin({ email: 'owner+lane@test.local' });

    expect(outcome.loggedInAs).toBe('owner+lane@test.local');
    expect((await userRow('owner+lane@test.local'))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('with the variable unset the matching address is an ordinary account — the omission is the safety (test/prod never set it)', async () => {
    delete process.env.DEV_BOOTSTRAP_ADMIN_EMAIL;

    await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

    expect((await userRow(BOOTSTRAP_EMAIL))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([['DEVELOPMENT'], ['DEV_AUTO_LOGIN_EMAIL']])(
    'gate closed (%s unset): 404 exactly as before — no session, no account, no admin; the variable changes nothing',
    async (gate) => {
      delete process.env[gate];

      const outcome = await invokeDevLogin({ email: BOOTSTRAP_EMAIL });

      expect(outcome.status).toBe(404);
      expect(outcome.loggedInAs).toBeUndefined();
      expect(outcome.sessionSaved).toBe(false);
      expect(await userRow(BOOTSTRAP_EMAIL)).toBeUndefined();
      expect(await auditRows()).toHaveLength(0);
      expect(await adminRows()).toHaveLength(0);
    }
  );
});
