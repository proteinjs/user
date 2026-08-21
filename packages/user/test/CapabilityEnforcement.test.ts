import { UserRepo } from '../src/UserRepo';

import moment from 'moment';
import { Db, DbDriver, getDb, getDbAsSystem, QueryBuilderFactory, Reference, StringColumn, Table } from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { getSharedDb, getSharedDbAsSystem, SharedRecord, withSharedRecordColumns } from '../src/SharedRecord';
import { AccessGrant, AccessGrantTable } from '../src/tables/AccessGrantTable';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '../src/tables/tables';

/**
 * Capability-enforcement floor (the sharing-capability bug set, 2026-08-20). A live probe on the
 * dev server proved four ways a caller could exceed their granted capability; these tests pin the
 * server-side floor that closes them, at the layer that owns each hole.
 *
 * HOLE 1 — privilege escalation: any caller who knows a resource id could insert an admin/owner
 *   AccessGrant for THEMSELVES (from a read grant, or from zero/revoked access), because
 *   AccessGrantTable.onBeforeInsert opened with a read-scoped `resource.get()` escape hatch that
 *   returned undefined for a no-access caller and SKIPPED the admin check.
 * HOLE 2 — row injection: a SharedRecord insert had no capability check at all; supplying
 *   `permissionSource` explicitly skipped the owner-grant default, so any authenticated caller
 *   could attach a row into ANY resource's permission scope.
 * DEFECT 3 — silent refusal: a read holder's id-targeted content write matched 0 rows and returned
 *   a silent 0, indistinguishable from a legit no-op — a tool reports false success. It must now
 *   surface a typed RecordAccessError, WITHOUT mis-flagging a genuine 0-row write.
 *
 * Outcome bar: assertions are against real grant state / persisted rows read back as system, never
 * against a call merely "succeeding".
 */

export interface SharedItem extends SharedRecord {
  name: string;
}

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

const users = [0, 1, 2].map((i) => ({
  name: `Test user${i}`,
  email: `test.user${i}`,
  password: 'test',
  emailVerified: false,
  roles: [] as string[],
  created: moment(),
  updated: moment(),
  id: `user${i}`,
}));

export class SharedItemTable extends Table<SharedItem> {
  name = 'user_test_shared_item';
  auth: Table<SharedItem>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<SharedItem>({
    name: new StringColumn('name'),
  });
}

const dbDriver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
const userRepo = new UserRepo();
const sharedItemTable = new SharedItemTable() as Table<SharedItem>;

const dropTable = async (table: Table<any>) => {
  if (await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).hasTable(table.name)) {
    await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).dropTable(table.name);
  }
};

const runAs = (userIndex: number) => userRepo.setUser(users[userIndex]);

const grantsFor = async (userId: string, resourceId: string): Promise<AccessGrant[]> => {
  const qb = new QueryBuilderFactory()
    .getQueryBuilder(tables.AccessGrant)
    .condition({ field: 'principal', operator: '=', value: userId })
    .condition({ field: 'resource', operator: '=', value: resourceId })
    .condition({ field: 'resourceTable', operator: '=', value: sharedItemTable.name });
  return await getDbAsSystem().query(tables.AccessGrant, qb);
};

const levelsFor = async (userId: string, resourceId: string) =>
  (await grantsFor(userId, resourceId)).map((grant) => grant.accessLevel).sort();

describe('Sharing capability enforcement floor', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      { getDbDriver: () => dbDriver },
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [tables.AccessGrant, sharedItemTable];
    (SourceRepository.get() as any).objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [userRepo];

    Session.setData({ sessionId: 'test-session', user: 'guest', data: {} });
    runAs(0);

    if (dbDriver.start) {
      await dbDriver.start();
    }

    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => dbDriver);
  });

  beforeEach(async () => {
    await dbDriver.getTableManager().loadTable(sharedItemTable);
    await dbDriver.getTableManager().loadTable(tables.AccessGrant);
  });

  afterEach(async () => {
    await dropTable(sharedItemTable);
    await dropTable(new AccessGrantTable());
  });

  afterAll(() => {
    if (dbDriver.stop) {
      dbDriver.stop();
    }
  });

  // ————————————————————————————————— HOLE 1 —————————————————————————————————

  it('HOLE 1 — a zero-access caller cannot self-grant admin', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'owned by user0' });

    // user1 holds NO grant and only knows the id.
    runAs(1);
    await expect(
      getDb().insert(tables.AccessGrant, {
        principal: new Reference('user', users[1].id),
        resource: new Reference(sharedItemTable.name, item.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'admin',
      })
    ).rejects.toThrow();

    expect(await levelsFor(users[1].id, item.id)).toEqual([]);
  });

  it('HOLE 1 — a read holder cannot self-escalate to admin (grant stays read)', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'owned by user0' });
    // Owner grants user1 read.
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, item.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'read',
    });

    runAs(1);
    await expect(
      getDb().insert(tables.AccessGrant, {
        principal: new Reference('user', users[1].id),
        resource: new Reference(sharedItemTable.name, item.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'admin',
      })
    ).rejects.toThrow();

    expect(await levelsFor(users[1].id, item.id)).toEqual(['read']);
  });

  it('HOLE 1 — a revoked caller (grants still owned by the real owner) cannot self-grant admin', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'owned by user0' });

    // user1 once had write, now revoked — the owner's grant still exists, so this is not a fresh
    // bootstrap; the caller must not be able to re-mint themselves any access.
    runAs(1);
    await expect(
      getDb().insert(tables.AccessGrant, {
        principal: new Reference('user', users[1].id),
        resource: new Reference(sharedItemTable.name, item.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'admin',
      })
    ).rejects.toThrow();

    expect(await levelsFor(users[1].id, item.id)).toEqual([]);
  });

  // ————————————————————————————————— HOLE 2 —————————————————————————————————

  it('HOLE 2 — a caller cannot inject a row into a resource scope it lacks write on', async () => {
    runAs(0);
    const victim = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'user0 doc' });

    // user1 has no grant on the victim doc; it explicitly points a NEW row at the victim's
    // permission scope (the explicit permissionSource is what skips the owner-grant default).
    runAs(1);
    await expect(
      getSharedDb().insert(sharedItemTable, {
        name: 'injected row',
        permissionSource: new Reference(sharedItemTable.name, victim.id),
        permissionSourceTable: sharedItemTable.name,
      } as Partial<SharedItem> as SharedItem)
    ).rejects.toThrow();

    // Nothing landed in the victim's scope as system truth.
    const rowsInVictimScope = await getSharedDbAsSystem().query(sharedItemTable, {
      permissionSource: victim.id,
    } as any);
    expect(rowsInVictimScope.map((r) => r.name)).not.toContain('injected row');
  });

  it('HOLE 2 — a write holder CAN insert a row into a scope it has write on (positive path)', async () => {
    runAs(0);
    const doc = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'user0 doc' });
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, doc.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'write',
    });

    runAs(1);
    const child = await getSharedDb().insert(sharedItemTable, {
      name: 'legit child',
      permissionSource: new Reference(sharedItemTable.name, doc.id),
      permissionSourceTable: sharedItemTable.name,
    } as Partial<SharedItem> as SharedItem);

    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: child.id });
    expect(persisted?.name).toBe('legit child');
  });

  // ————————————————————————————————— DEFECT 3 —————————————————————————————————

  it('DEFECT 3 — a read holder id-targeted write surfaces a typed RecordAccessError', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'original' });
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, item.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'read',
    });

    runAs(1);
    let caught: any;
    try {
      await getSharedDb().update(sharedItemTable, { id: item.id, name: 'hacked' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.name).toBe('RecordAccessError');

    // And nothing was persisted.
    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: item.id });
    expect(persisted?.name).toBe('original');
  });

  it('DEFECT 3 — a genuinely absent-row write is NOT mis-flagged (legit 0, no throw)', async () => {
    runAs(0);
    // Owner updates an id that does not exist — a real no-op, must return 0 and not throw.
    const count = await getSharedDb().update(sharedItemTable, { id: 'does-not-exist', name: 'x' });
    expect(count).toBe(0);
  });

  it('DEFECT 3 — a write holder updating a row it can write is NOT mis-flagged', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'original' });
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, item.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'write',
    });

    runAs(1);
    // Same-value update: MySQL may report 0 changed rows — must NOT be flagged as a denial.
    await expect(getSharedDb().update(sharedItemTable, { id: item.id, name: 'original' })).resolves.not.toThrow?.();
    // A real edit persists.
    await getSharedDb().update(sharedItemTable, { id: item.id, name: 'edited by writer' });
    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: item.id });
    expect(persisted?.name).toBe('edited by writer');
  });

  // ————————————————————————————————— REGRESSIONS —————————————————————————————————

  it('REGRESSION — owner create/update/delete positive path still works', async () => {
    runAs(0);
    const item = await getSharedDb().insert(sharedItemTable, { name: 'owner doc' });
    // Bootstrap owner grant exists.
    expect(await levelsFor(users[0].id, item.id)).toEqual(['owner']);

    const updated = await getSharedDb().update(sharedItemTable, { id: item.id, name: 'owner edit' });
    expect(updated).toBe(1);

    const deleted = await getSharedDb().delete(sharedItemTable, { id: item.id });
    expect(deleted).toBe(1);
  });

  it('REGRESSION — an admin can still grant access to another user', async () => {
    runAs(0);
    const item = await getSharedDb().insert(sharedItemTable, { name: 'owner doc' });

    const grant = await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, item.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'write',
    });
    expect(grant.id).toBeDefined();
    expect(await levelsFor(users[1].id, item.id)).toEqual(['write']);
  });

  it('REGRESSION — system-context writes (maintenance) still succeed for any actor', async () => {
    runAs(1);
    // A non-admin actor's system-context write (e.g. an op-ledger journal) is unaffected.
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'system row' });
    const count = await getSharedDbAsSystem().update(sharedItemTable, { id: item.id, name: 'system edit' });
    expect(count).toBe(1);
    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: item.id });
    expect(persisted?.name).toBe('system edit');
  });
});
