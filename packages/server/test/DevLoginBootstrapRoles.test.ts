import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { SourceRepository } from '@proteinjs/reflection';
import { RoleCatalogEntry, tables } from '@proteinjs/user';
import { invokeDevLogin } from './devLoginHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * `DEV_BOOTSTRAP_ROLES` — the dev role-bootstrap door INSIDE `/dev/login`. A fresh development
 * database has one admin at most (the first-admin door) and every other account is role-less —
 * so a consumer's `adminGrantOnly` roles needed a manual admin act on every fresh database. The
 * same door, the same two gates, one more variable: `email:role[,role];email:role…` — on a hit
 * whose resolved address is listed, the listed roles the account does not hold are granted, once
 * each:
 *  - behind the door's existing two gates (DEVELOPMENT AND DEV_AUTO_LOGIN_EMAIL): closed = 404 as
 *    before, and the variable changes nothing;
 *  - only for the request whose resolved address equals a listed address exactly (case-normalized
 *    the way every account email is) — every other address is untouched;
 *  - idempotent: a role the account holds is reported `held`, never re-granted, never re-audited;
 *    nothing is EVER revoked (a role the list does not name stays);
 *  - admin-grant-only roles are granted (that is the point — a fresh development database has no
 *    admin to grant them); break-glass and roles the catalog does not know are REFUSED and named;
 *  - each grant is audited like any grant (a role_grant_event row; actor = the account itself);
 *  - the outcome is ONE marker line, `[dev-bootstrap] <email>: granted …; held …; refused …`, the
 *    line provisioning tooling reads back from the server log as its proof.
 * Outcomes are asserted on the rows (roles, audit), the marker line on the logger (it IS the
 * contract its readers parse).
 */

const ENV_EMAIL = 'dev@test.local';
const TEAM_EMAIL = 'team@test.local';
const OPS_EMAIL = 'ops@test.local';
const ROLES_ENV = `${TEAM_EMAIL}:staff,dev;${OPS_EMAIL}:ops`;

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };

const userRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });
const auditRows = async () => await getDbAsSystem().query(tables.RoleGrantEvent, {});
const adminRows = async () =>
  (await getDbAsSystem().query(tables.User, {})).filter((user) => (user.roles ?? []).includes('admin'));

describe('devLogin — the DEV_BOOTSTRAP_ROLES role-bootstrap door', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
    DEV_BOOTSTRAP_ADMIN_EMAIL: process.env.DEV_BOOTSTRAP_ADMIN_EMAIL,
    DEV_BOOTSTRAP_ROLES: process.env.DEV_BOOTSTRAP_ROLES,
  };
  let infoSpy: jest.SpyInstance;
  const markerLines = () =>
    infoSpy.mock.calls
      .map((call) => String((call[0] as { message?: string })?.message ?? ''))
      .filter((message) => message.startsWith('[dev-bootstrap]'));

  beforeAll(async () => {
    await testEnv.beforeAll();
    // A consumer's catalog shape: 'staff' is admin-grant-only, 'dev'/'ops' plain.
    (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache['@proteinjs/user/RoleCatalogEntry'] = [
      { role: 'staff', description: 'Staff member', adminGrantOnly: true } as RoleCatalogEntry,
      { role: 'dev', description: 'Developer tooling' } as RoleCatalogEntry,
      { role: 'ops', description: 'Operations' } as RoleCatalogEntry,
    ];
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = ENV_EMAIL;
    delete process.env.DEV_BOOTSTRAP_ADMIN_EMAIL;
    process.env.DEV_BOOTSTRAP_ROLES = ROLES_ENV;
    infoSpy = jest.spyOn(Logger.prototype, 'info');
    // Every case starts from a fresh database: no accounts, no audit trail.
    const db = getDbAsSystem();
    await db.delete(tables.RoleGrantEvent, {});
    await db.delete(tables.User, {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('a fresh database + a listed address: the account is created carrying the listed roles (the admin-grant-only one included), one audit row per role, logged in, and the marker line names the grants', async () => {
    expect(await userRow(TEAM_EMAIL)).toBeUndefined();

    const outcome = await invokeDevLogin({ email: TEAM_EMAIL });

    expect(outcome.loggedInAs).toBe(TEAM_EMAIL);
    expect(outcome.sessionSaved).toBe(true);
    expect(outcome.redirect).toBe('/');
    const team = await userRow(TEAM_EMAIL);
    expect(team!.roles).toEqual(['staff', 'dev']);
    const events = await auditRows();
    expect(events.map((e) => ({ actor: e.actor, target: e.target, role: e.role, action: e.action }))).toEqual(
      expect.arrayContaining([
        { actor: team!.id, target: team!.id, role: 'staff', action: 'grant' },
        { actor: team!.id, target: team!.id, role: 'dev', action: 'grant' },
      ])
    );
    expect(events).toHaveLength(2);
    expect(markerLines()).toEqual([`[dev-bootstrap] ${TEAM_EMAIL}: granted staff, dev; held (none); refused (none)`]);
  });

  it('a second hit for the same address writes nothing: the roles stand, the audit trail is unchanged, the marker line reports them held', async () => {
    await invokeDevLogin({ email: TEAM_EMAIL });
    infoSpy.mockClear();

    const outcome = await invokeDevLogin({ email: TEAM_EMAIL });

    expect(outcome.loggedInAs).toBe(TEAM_EMAIL);
    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['staff', 'dev']);
    expect(await auditRows()).toHaveLength(2);
    expect(markerLines()).toEqual([`[dev-bootstrap] ${TEAM_EMAIL}: granted (none); held staff, dev; refused (none)`]);
  });

  it('an existing account holding one listed role and one unlisted role: only the missing role is granted, the unlisted one stays — the door never revokes', async () => {
    await testEnv.createUser({ name: 'Team', email: TEAM_EMAIL, roles: ['dev', 'sessions'] });

    await invokeDevLogin({ email: TEAM_EMAIL });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['dev', 'sessions', 'staff']);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ role: 'staff', action: 'grant' });
    expect(markerLines()).toEqual([`[dev-bootstrap] ${TEAM_EMAIL}: granted staff; held dev; refused (none)`]);
  });

  it('an address the list does not name: an ordinary account, no grant, no audit row, no marker line — and the listed addresses stay uncreated', async () => {
    const outcome = await invokeDevLogin({ email: 'agent@test.local' });

    expect(outcome.loggedInAs).toBe('agent@test.local');
    expect((await userRow('agent@test.local'))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(markerLines()).toEqual([]);
    expect(await userRow(TEAM_EMAIL)).toBeUndefined();
    expect(await userRow(OPS_EMAIL)).toBeUndefined();
  });

  it('each listed address gets ITS roles only — the second entry never inherits the first', async () => {
    await invokeDevLogin({ email: OPS_EMAIL });

    expect((await userRow(OPS_EMAIL))!.roles).toEqual(['ops']);
    expect(await auditRows()).toHaveLength(1);
    expect(markerLines()).toEqual([`[dev-bootstrap] ${OPS_EMAIL}: granted ops; held (none); refused (none)`]);
  });

  it('the match is case-normalized like every account email, and the grammar tolerates whitespace around every token', async () => {
    process.env.DEV_BOOTSTRAP_ROLES = ` Team@Test.local : staff , dev ; ${OPS_EMAIL}: ops `;

    await invokeDevLogin({ email: 'team@test.local' });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['staff', 'dev']);
    expect(await auditRows()).toHaveLength(2);
  });

  it('a role the catalog does not know is refused and named; the known roles in the same entry are still granted', async () => {
    process.env.DEV_BOOTSTRAP_ROLES = `${TEAM_EMAIL}:staff,no-such-role`;

    await invokeDevLogin({ email: TEAM_EMAIL });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['staff']);
    expect(await auditRows()).toHaveLength(1);
    expect(markerLines()).toEqual([
      `[dev-bootstrap] ${TEAM_EMAIL}: granted staff; held (none); refused no-such-role (unknown role)`,
    ]);
  });

  it("break-glass is never this door's to grant: 'admin' in the list is refused and named (the first-admin door is the one path)", async () => {
    process.env.DEV_BOOTSTRAP_ROLES = `${TEAM_EMAIL}:admin,dev`;

    await invokeDevLogin({ email: TEAM_EMAIL });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['dev']);
    expect(await adminRows()).toHaveLength(0);
    expect((await auditRows()).map((e) => e.role)).toEqual(['dev']);
    expect(markerLines()).toEqual([
      `[dev-bootstrap] ${TEAM_EMAIL}: granted dev; held (none); refused admin (break-glass)`,
    ]);
  });

  it('the default path is a request for DEV_AUTO_LOGIN_EMAIL: when that address is listed, the default account carries the roles', async () => {
    process.env.DEV_BOOTSTRAP_ROLES = `${ENV_EMAIL}:dev`;

    const outcome = await invokeDevLogin();

    expect(outcome.loggedInAs).toBe(ENV_EMAIL);
    expect((await userRow(ENV_EMAIL))!.roles).toEqual(['dev']);
    expect(await auditRows()).toHaveLength(1);
  });

  it('composes with the first-admin door: the same address listed in both gets admin first, then its roles — three audited grants, one account', async () => {
    process.env.DEV_BOOTSTRAP_ADMIN_EMAIL = TEAM_EMAIL;

    await invokeDevLogin({ email: TEAM_EMAIL });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['admin', 'staff', 'dev']);
    expect(await auditRows()).toHaveLength(3);
    expect(await adminRows()).toHaveLength(1);
  });

  it('with the variable unset a listed address is an ordinary account — the omission is the safety (a deployment outside development never sets it)', async () => {
    delete process.env.DEV_BOOTSTRAP_ROLES;

    await invokeDevLogin({ email: TEAM_EMAIL });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(markerLines()).toEqual([]);
  });

  it('malformed entries (no colon, no roles) are ignored; the well-formed entries beside them are honored', async () => {
    process.env.DEV_BOOTSTRAP_ROLES = `garbage;${OPS_EMAIL}:;${TEAM_EMAIL}:dev;:ops`;

    await invokeDevLogin({ email: TEAM_EMAIL });
    await invokeDevLogin({ email: OPS_EMAIL });

    expect((await userRow(TEAM_EMAIL))!.roles).toEqual(['dev']);
    expect((await userRow(OPS_EMAIL))!.roles).toEqual([]);
    expect(await auditRows()).toHaveLength(1);
  });

  it.each([['DEVELOPMENT'], ['DEV_AUTO_LOGIN_EMAIL']])(
    'gate closed (%s unset): 404 exactly as before — no session, no account, no grant; the variable changes nothing',
    async (gate) => {
      delete process.env[gate];

      const outcome = await invokeDevLogin({ email: TEAM_EMAIL });

      expect(outcome.status).toBe(404);
      expect(outcome.loggedInAs).toBeUndefined();
      expect(outcome.sessionSaved).toBe(false);
      expect(await userRow(TEAM_EMAIL)).toBeUndefined();
      expect(await auditRows()).toHaveLength(0);
      expect(markerLines()).toEqual([]);
    }
  );
});
