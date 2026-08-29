import moment from 'moment';
import { Db, Table, getDbAsSystem } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { SourceRepository } from '@proteinjs/reflection';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { RoleCatalogEntry, USER_PERMISSIONS, UserRepo, tables } from '@proteinjs/user';
import { Roles } from '../src/services/Roles';

/**
 * The Roles service is the ONE write path for user roles: grants/revokes validated against the
 * roles catalog, the role update and its `role_grant_event` audit row committed together.
 * Outcomes asserted against a real Spanner emulator: the rows written, not the calls made.
 *
 * The service door itself (`{ permission: 'roles' }`) is resolved by ServiceAuth — covered in
 * @proteinjs/service — so these tests call the implementation directly and pin the metadata.
 */

class TestSessionDataStorage implements SessionDataStorage {
  environment = 'node' as 'node';
  static SESSION_DATA: { [id: string]: SessionData } = {};

  setData(data: SessionData) {
    TestSessionDataStorage.SESSION_DATA['sessionData'] = data;
  }

  getData(): SessionData {
    return TestSessionDataStorage.SESSION_DATA['sessionData'];
  }
}

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

class DbDriverFactory {
  getDbDriver() {
    return spannerDriver;
  }
}

const actor = {
  name: 'Role granter',
  email: 'granter@test.local',
  password: 'test',
  emailVerified: true,
  roles: ['admin'],
  created: moment(),
  updated: moment(),
  id: 'actor-1',
};

const dropTable = getDropTestTable(spannerDriver);

describe('Roles service — grant/revoke outcomes and audit trail', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [new DbDriverFactory()];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/user/RoleCatalogEntry'] = [
      { role: 'ops', description: 'Run the ops cockpit' } as RoleCatalogEntry,
      { role: 'dev', description: 'Drive the dev tooling' } as RoleCatalogEntry,
      // Admin-grant-only entry (the consumer compliance-grant shape): granting requires the
      // caller to BE an admin; the ordinary 'roles' grant does not cover it.
      { role: 'data-access', description: 'Compliance decrypt grant', adminGrantOnly: true } as RoleCatalogEntry,
    ];
    // The admin-grant-only check resolves the CALLER through UserAuth — same session-backed
    // repo the services use.
    (SourceRepository.get() as any).objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => spannerDriver);

    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(tables.User as Table<any>);
    await dropTable(tables.RoleGrantEvent as Table<any>);
    await spannerDriver.getTableManager().loadTable(tables.User);
    await spannerDriver.getTableManager().loadTable(tables.RoleGrantEvent);

    Session.setData({ sessionId: 'test-session', user: actor.email, data: {} });
    new UserRepo().setUser(actor);
  }, 120000);

  afterAll(async () => {
    await dropTable(tables.User as Table<any>);
    await dropTable(tables.RoleGrantEvent as Table<any>);
    await SpannerEmulatorProvisioner.release();
  }, 60000);

  let targetId: string;

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.RoleGrantEvent, {});
    await db.delete(tables.User, {});
    await db.insert(tables.User, { ...actor });
    const target = await db.insert(tables.User, {
      name: 'Target user',
      email: 'target@test.local',
      password: 'test',
      emailVerified: true,
      roles: [],
    });
    targetId = target.id;
  }, 60000);

  const targetRoles = async () => (await getDbAsSystem().get(tables.User, { id: targetId }))!.roles;
  const auditRows = async () => await getDbAsSystem().query(tables.RoleGrantEvent, {});

  it('requires the roles permission on its service door', () => {
    expect(new Roles().serviceMetadata?.auth?.permission).toBe(USER_PERMISSIONS.roles);
  });

  it('grant writes the role on the user row and one audit row', async () => {
    await new Roles().grantRole(targetId, 'ops');

    expect(await targetRoles()).toEqual(['ops']);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'actor-1', target: targetId, role: 'ops', action: 'grant' });
    expect(events[0].created).toBeDefined();
  }, 60000);

  it('granting an already-held role changes nothing and writes no audit row', async () => {
    const roles = new Roles();
    await roles.grantRole(targetId, 'ops');
    await roles.grantRole(targetId, 'ops');

    expect(await targetRoles()).toEqual(['ops']);
    expect(await auditRows()).toHaveLength(1);
  }, 60000);

  it('revoke removes the role and audits the revoke', async () => {
    const roles = new Roles();
    await roles.grantRole(targetId, 'ops');
    await roles.grantRole(targetId, 'dev');
    await roles.revokeRole(targetId, 'ops');

    expect(await targetRoles()).toEqual(['dev']);
    const events = await auditRows();
    expect(events).toHaveLength(3);
    const revoke = events.find((event) => event.action === 'revoke');
    expect(revoke).toMatchObject({ actor: 'actor-1', target: targetId, role: 'ops' });
  }, 60000);

  it('refuses to grant the break-glass role, and writes nothing — the only path to admin is a manual UPDATE in Spanner Studio', async () => {
    // The error teaches: names break-glass, refuses the grant, and points at the one real path.
    await expect(new Roles().grantRole(targetId, 'admin')).rejects.toThrow(
      /break-glass role — this service refuses to grant it.*manual UPDATE on the user row in Spanner Studio/
    );

    // A refusal is not a role change: no user write, no audit row (the trail records what
    // happened, and nothing happened).
    expect(await targetRoles()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  }, 60000);

  it('revokes the break-glass role — de-escalation through the audited path stays available', async () => {
    // Admin arrives only via the manual database path; mirror that here with a system write.
    await getDbAsSystem().update(tables.User, { id: targetId, roles: ['admin'] });

    await new Roles().revokeRole(targetId, 'admin');

    expect(await targetRoles()).toEqual([]);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'actor-1', target: targetId, role: 'admin', action: 'revoke' });
  }, 60000);

  it('revoking a role the user does not hold changes nothing and writes no audit row', async () => {
    await new Roles().revokeRole(targetId, 'ops');

    expect(await targetRoles()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  }, 60000);

  it('refuses a role the catalog does not know, and writes nothing', async () => {
    await expect(new Roles().grantRole(targetId, 'made-up')).rejects.toThrow(
      `'made-up' is not a known role. Pick one from the roles catalog.`
    );
    expect(await targetRoles()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  }, 60000);

  it('refuses a grant to a user that does not exist', async () => {
    await expect(new Roles().grantRole('nobody-1', 'ops')).rejects.toThrow('No user found for id: nobody-1');
    expect(await auditRows()).toHaveLength(0);
  }, 60000);

  it('refuses to grant an admin-grant-only role when the caller is not an admin — and writes nothing', async () => {
    // A user-admin's full day-to-day grant set — pointedly including 'roles' (the door this
    // service sits behind) — must NOT be able to hand out an admin-grant-only role.
    new UserRepo().setUser({ ...actor, roles: ['users', 'roles', 'sessions'] });
    try {
      await expect(new Roles().grantRole(targetId, 'data-access')).rejects.toThrow(/can only be granted by an admin/);
      expect(await targetRoles()).toEqual([]);
      expect(await auditRows()).toHaveLength(0);
    } finally {
      new UserRepo().setUser(actor);
    }
  }, 60000);

  it('grants an admin-grant-only role when the caller IS an admin, audited like any grant', async () => {
    await new Roles().grantRole(targetId, 'data-access');

    expect(await targetRoles()).toEqual(['data-access']);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'actor-1', target: targetId, role: 'data-access', action: 'grant' });
  }, 60000);

  it('a roles-holder can still REVOKE an admin-grant-only role — de-escalation stays open (the break-glass precedent)', async () => {
    await new Roles().grantRole(targetId, 'data-access');
    new UserRepo().setUser({ ...actor, roles: ['roles'] });
    try {
      await new Roles().revokeRole(targetId, 'data-access');
      expect(await targetRoles()).toEqual([]);
      expect((await auditRows()).map((event) => event.action).sort()).toEqual(['grant', 'revoke']);
    } finally {
      new UserRepo().setUser(actor);
    }
  }, 60000);
});
