import { getDbAsSystem, QueryBuilder, Reference, Table, TableWatcher } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { AccessGrant, tables, User } from '@proteinjs/user';
import { SweepMalformedAccessGrants } from '../src/migrations/SweepMalformedAccessGrants';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

/** Same harness cast as MachineAccounts.integration.test.ts: recompute the static watcher map on the next Db. */
const resetTableWatcherMap = () => {
  const runner = (getDbAsSystem() as unknown as { tableWatcherRunner: object }).tableWatcherRunner;
  (runner.constructor as { tableWatcherMap?: unknown }).tableWatcherMap = undefined;
};

/**
 * Observes access_grant deletes the way the app's watchers do (ContentReferenceAccessGrantTableWatcher
 * lives in space-common, above this package): a delete that rides the Db layer lands here with the
 * deleted rows; a raw-SQL delete never would.
 */
class RecordingAccessGrantWatcher implements TableWatcher<AccessGrant> {
  static deletedIds: string[] = [];

  name(): string {
    return 'RecordingAccessGrantWatcher';
  }

  table(): Table<AccessGrant> {
    return tables.AccessGrant;
  }

  async afterDelete<T extends AccessGrant>(_count: number, deletedRecords: T[]): Promise<void> {
    for (const record of deletedRecords) {
      RecordingAccessGrantWatcher.deletedIds.push(record.id);
    }
  }
}

/**
 * SweepMalformedAccessGrants (one-time migration): the AccessGrant well-formedness invariant now
 * refuses a grant with no principal or resource id, but the rows its two pre-fix producers left
 * behind (the test environment's NULL-principal `thought` grant that crashed Deploy to Test
 * 32614670162) are still there. The sweep deletes EXACTLY the invariant's complement
 * (`principal IS NULL OR resource IS NULL`) by id through the Db layer — watchers fire — and
 * nothing else: well-formed grants survive, and DANGLING grants (non-null ids pointing at purged
 * rows) are reported, never deleted. Idempotent.
 *
 * Red-first: written against the contract; a no-op sweep fails the delete legs, and a sweep on
 * the wrong predicate fails the well-formed-survives legs.
 */
describe('SweepMalformedAccessGrants — deletes exactly the malformed rows through the Db layer; reports dangling; idempotent', () => {
  let owner: User;
  let grantee: User;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // The dangling report resolves resource tables by name off the source graph (none is loaded
    // in tests) — register exactly this package's tables, as the app's composition would.
    objectCache()['@proteinjs/db/Table'] = Object.values(tables);
    objectCache()['@proteinjs/db/TableWatcher'] = [new RecordingAccessGrantWatcher()];
    resetTableWatcherMap();
  }, 120_000);

  afterAll(async () => {
    delete objectCache()['@proteinjs/db/Table'];
    delete objectCache()['@proteinjs/db/TableWatcher'];
    resetTableWatcherMap();
    await testEnv.afterAll();
  }, 60_000);

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.User, {});
    RecordingAccessGrantWatcher.deletedIds = [];
    owner = await testEnv.createUser({ name: 'Owner', email: 'owner@test.local' });
    grantee = await testEnv.createUser({ name: 'Grantee', email: 'grantee@test.local' });
  });

  /** A well-formed grant, inserted as system (the invariant admits it). Resource rides the user table here. */
  async function insertGrant(args: {
    principalId: string;
    resourceId: string;
    resourceTable?: string;
    accessLevel: AccessGrant['accessLevel'];
  }): Promise<AccessGrant> {
    const resourceTable = args.resourceTable ?? tables.User.name;
    return await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference(tables.User.name, args.principalId),
      resource: new Reference(resourceTable, args.resourceId),
      resourceTable,
      accessLevel: args.accessLevel,
    });
  }

  /**
   * Seed the malformed shape BENEATH the insert invariant (which rightly refuses it now): insert
   * well-formed, then null the reference in place — the row the environment actually holds.
   */
  async function nullOut(grantId: string, field: 'principal' | 'resource'): Promise<void> {
    await getDbAsSystem().update(tables.AccessGrant, { [field]: null } as Partial<AccessGrant>, { id: grantId });
  }

  async function grantById(id: string): Promise<AccessGrant | undefined> {
    return await getDbAsSystem().get(tables.AccessGrant, { id });
  }

  async function allGrantIds(): Promise<string[]> {
    const grants = await getDbAsSystem().query(
      tables.AccessGrant,
      new QueryBuilder<AccessGrant>(tables.AccessGrant.name)
    );
    return grants.map((grant) => grant.id).sort();
  }

  it('dry run reports without deleting; real run deletes exactly the malformed rows (watchers fire); well-formed and dangling survive; re-run is a no-op', async () => {
    // Well-formed — must survive untouched.
    const ownerGrant = await insertGrant({ principalId: owner.id, resourceId: owner.id, accessLevel: 'owner' });
    const readGrant = await insertGrant({ principalId: grantee.id, resourceId: owner.id, accessLevel: 'read' });
    // Malformed — the invariant's complement, one of each shape.
    const nullPrincipal = await insertGrant({ principalId: grantee.id, resourceId: owner.id, accessLevel: 'write' });
    await nullOut(nullPrincipal.id, 'principal');
    const nullResource = await insertGrant({ principalId: grantee.id, resourceId: owner.id, accessLevel: 'admin' });
    await nullOut(nullResource.id, 'resource');
    // Dangling — well-formed ids that resolve to nothing. A separate class: reported, never deleted.
    const purgedPrincipal = await insertGrant({
      principalId: 'purged-user',
      resourceId: owner.id,
      accessLevel: 'read',
    });
    const purgedResource = await insertGrant({
      principalId: grantee.id,
      resourceId: 'purged-row',
      accessLevel: 'read',
    });
    const unregisteredTable = await insertGrant({
      principalId: grantee.id,
      resourceId: 'some-thought',
      resourceTable: 'thought',
      accessLevel: 'write',
    });

    expect((await grantById(nullPrincipal.id))?.principal ?? null).toBeNull();
    expect((await grantById(nullResource.id))?.resource ?? null).toBeNull();
    const seededIds = [
      ownerGrant.id,
      readGrant.id,
      nullPrincipal.id,
      nullResource.id,
      purgedPrincipal.id,
      purgedResource.id,
      unregisteredTable.id,
    ].sort();
    expect(await allGrantIds()).toEqual(seededIds);

    const sweep = new SweepMalformedAccessGrants();

    // ---------- DRY RUN: the two malformed rows are listed; nothing is deleted ----------
    const dry = await sweep.sweep({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.malformed).toBe(2);
    expect(dry.rows.map((row) => row.id).sort()).toEqual([nullPrincipal.id, nullResource.id].sort());
    expect(dry.rows.find((row) => row.id === nullPrincipal.id)).toMatchObject({
      resourceTable: tables.User.name,
      accessLevel: 'write',
    });
    expect(dry.rows.every((row) => typeof row.created === 'string' && row.created.length > 0)).toBe(true);
    expect(await allGrantIds()).toEqual(seededIds);
    expect(RecordingAccessGrantWatcher.deletedIds).toEqual([]);

    // ---------- REAL RUN: exactly the malformed rows go, through the Db layer ----------
    const real = await sweep.sweep({ dryRun: false });
    expect(real.dryRun).toBe(false);
    expect(real.malformed).toBe(2);
    expect(await grantById(nullPrincipal.id)).toBeUndefined();
    expect(await grantById(nullResource.id)).toBeUndefined();
    // The after-delete watchers saw precisely the deleted rows — the delete rode the Db layer.
    expect(RecordingAccessGrantWatcher.deletedIds.sort()).toEqual([nullPrincipal.id, nullResource.id].sort());
    // Well-formed rows intact, levels unchanged.
    expect((await grantById(ownerGrant.id))?.accessLevel).toBe('owner');
    expect((await grantById(readGrant.id))?.accessLevel).toBe('read');
    // Dangling rows intact — reported below, not deleted.
    expect(await grantById(purgedPrincipal.id)).toBeDefined();
    expect(await grantById(purgedResource.id)).toBeDefined();
    expect(await grantById(unregisteredTable.id)).toBeDefined();
    expect(await allGrantIds()).toEqual(
      [ownerGrant.id, readGrant.id, purgedPrincipal.id, purgedResource.id, unregisteredTable.id].sort()
    );

    // ---------- DANGLING REPORT: each purged reference named with its reason; still nothing deleted ----------
    const dangling = await sweep.reportDangling();
    expect(dangling.danglingPrincipal).toBe(1);
    expect(dangling.danglingResource).toBe(2);
    expect(dangling.rows.find((row) => row.id === purgedPrincipal.id)).toMatchObject({
      principal: 'purged-user',
      reason: 'principal missing',
    });
    expect(dangling.rows.find((row) => row.id === purgedResource.id)).toMatchObject({
      resource: 'purged-row',
      reason: 'resource missing',
    });
    expect(dangling.rows.find((row) => row.id === unregisteredTable.id)).toMatchObject({
      resourceTable: 'thought',
      reason: 'resource table not registered',
    });
    expect(dangling.rows.map((row) => row.id)).not.toContain(ownerGrant.id);
    expect(dangling.rows.map((row) => row.id)).not.toContain(readGrant.id);
    expect(await allGrantIds()).toEqual(
      [ownerGrant.id, readGrant.id, purgedPrincipal.id, purgedResource.id, unregisteredTable.id].sort()
    );

    // ---------- IDEMPOTENCY: a second real run finds nothing, deletes nothing ----------
    RecordingAccessGrantWatcher.deletedIds = [];
    const again = await sweep.sweep({ dryRun: false });
    expect(again.malformed).toBe(0);
    expect(again.rows).toEqual([]);
    expect(RecordingAccessGrantWatcher.deletedIds).toEqual([]);
    expect(await allGrantIds()).toEqual(
      [ownerGrant.id, readGrant.id, purgedPrincipal.id, purgedResource.id, unregisteredTable.id].sort()
    );
  }, 120_000);

  it('the migration record runs dry-run pass, delete pass, and dangling report; its output carries the rows; a second run is zero', async () => {
    const ownerGrant = await insertGrant({ principalId: owner.id, resourceId: owner.id, accessLevel: 'owner' });
    const nullPrincipal = await insertGrant({ principalId: grantee.id, resourceId: owner.id, accessLevel: 'read' });
    await nullOut(nullPrincipal.id, 'principal');
    const purgedPrincipal = await insertGrant({
      principalId: 'purged-user',
      resourceId: owner.id,
      accessLevel: 'read',
    });

    const migration = new SweepMalformedAccessGrants();
    expect(migration.table.name).toBe('migration');

    const output = await migration.record.run();
    expect(output).toMatchObject({
      malformedDryRun: 1,
      malformed: 1,
      danglingPrincipal: 1,
      danglingResource: 0,
    });
    expect(output.malformedRows.map((row) => row.id)).toEqual([nullPrincipal.id]);
    expect(output.danglingRows.map((row) => row.id)).toEqual([purgedPrincipal.id]);
    expect(await allGrantIds()).toEqual([ownerGrant.id, purgedPrincipal.id].sort());
    expect(RecordingAccessGrantWatcher.deletedIds).toEqual([nullPrincipal.id]);

    const second = await migration.record.run();
    expect(second).toMatchObject({ malformedDryRun: 0, malformed: 0, danglingPrincipal: 1, danglingResource: 0 });
    expect(second.malformedRows).toEqual([]);
    expect(await allGrantIds()).toEqual([ownerGrant.id, purgedPrincipal.id].sort());
  }, 120_000);
});
