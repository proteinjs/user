import { Db, Table, getDbAsSystem } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { BackfillUserRolesArray } from '../src/migrations/BackfillUserRolesArray';
import { RetireLegacyUserRolesColumn } from '../src/migrations/RetireLegacyUserRolesColumn';

/**
 * The user.roles cutover migrations against a real Spanner emulator, simulating a deployed
 * database: the user table carries the NEW schema (role_list, added by schema sync) PLUS the
 * legacy comma-string `roles` column with pre-cutover data — exactly the state a deployment is
 * in when the migrations run. Every read below goes through the ORM: what the row reader makes
 * of a row holding BOTH cells — the legacy `roles` (a word, an empty string, NULL) and the typed
 * `role_list` — is the law this suite proves, not a comment's claim.
 *
 * Pinned outcomes:
 * - legacy comma strings land in role_list as normalized arrays (trim, drop empties, dedupe)
 * - empty/NULL legacy values stay untouched by the backfill (no roles then, no roles now)
 * - rows already carrying role_list are never clobbered (idempotence / post-cutover grants win),
 *   and the ORM reads the array beside the stale legacy word
 * - the retirement NULLs every legacy cell the typed column has absorbed — or that held nothing —
 *   and never one the backfill has not consumed; the ORM reads the same arrays before and after
 *   (a NULL legacy cell beside the array is the shape a row reader seating by property name
 *   would blank)
 * - a database that never had the legacy column (fresh install) is a clean no-op for both
 */

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

const dropTable = getDropTestTable(spannerDriver);

const runMigration = async () => await new BackfillUserRolesArray().record.run();
const runRetirement = async () => await new RetireLegacyUserRolesColumn().record.run();
const estimateRetirement = async () => await new RetireLegacyUserRolesColumn().record.estimate();

const rawUserInsert = async (id: string, legacyRoles: string | null) => {
  const rolesValue = legacyRoles === null ? 'NULL' : `'${legacyRoles}'`;
  await spannerDriver.runDml(() => ({
    sql:
      `INSERT INTO ${tables.User.name} (id, name, email, password, email_verified, roles, created, updated) ` +
      `VALUES ('${id}', 'User ${id}', '${id}@test.local', 'test', false, ${rolesValue}, ` +
      `CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
  }));
};

const rawRoleList = async (id: string) =>
  (
    (await spannerDriver.runQuery(() => ({
      sql: `SELECT role_list FROM ${tables.User.name} WHERE id = '${id}'`,
    }))) as unknown as Array<{ role_list: string | null }>
  )[0].role_list;

/** The legacy cell as the database holds it. */
const rawRoles = async (id: string) =>
  (
    (await spannerDriver.runQuery(() => ({
      sql: `SELECT roles FROM ${tables.User.name} WHERE id = '${id}'`,
    }))) as unknown as Array<{ roles: string | null }>
  )[0].roles;

describe('BackfillUserRolesArray — legacy comma-string roles → typed role_list', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [new DbDriverFactory()];
    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => spannerDriver);

    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(tables.User as Table<any>);
    await spannerDriver.getTableManager().loadTable(tables.User);
  }, 120000);

  afterAll(async () => {
    await dropTable(tables.User as Table<any>);
    await SpannerEmulatorProvisioner.release();
  }, 60000);

  it('is a clean no-op on a database that never had the legacy roles column', async () => {
    expect(await runMigration()).toEqual({ backfilled: 0 });
    expect(await runRetirement()).toEqual({ retired: 0 });
    expect(await estimateRetirement()).toMatchObject({ units: 0, unit: 'rows' });
  }, 60000);

  it('retires every legacy cell the typed column has absorbed, never one the backfill has not consumed; the ORM reads the same arrays before and after', async () => {
    await spannerDriver.runUpdateSchema(`ALTER TABLE ${tables.User.name} ADD COLUMN roles STRING(255)`);
    const db = getDbAsSystem();
    try {
      await rawUserInsert('retire-carried', 'admin');
      await rawUserInsert('retire-empty', '');
      await rawUserInsert('retire-null', null);
      // A legacy value the backfill has not consumed yet: role_list NULL, legacy text present.
      await rawUserInsert('retire-unconsumed', 'ops');
      // A post-cutover grant beside a stale legacy word (the collision shape).
      const granted = await db.insert(tables.User, {
        name: 'Granted',
        email: 'granted@test.local',
        password: 'test',
        emailVerified: false,
        roles: ['ops', 'dev'],
      });
      await spannerDriver.runDml(() => ({
        sql: `UPDATE ${tables.User.name} SET roles = 'admin' WHERE id = '${granted.id}'`,
      }));
      // Carry the one consumable legacy value over (as the backfill would); leave 'retire-unconsumed' as a later backfill's.
      await db.update(tables.User, { id: 'retire-carried', roles: ['admin'] });

      // Before: the ORM reads the arrays beside the legacy cells, whatever they hold.
      expect((await db.get(tables.User, { id: 'retire-carried' })).roles).toEqual(['admin']);
      expect((await db.get(tables.User, { id: granted.id })).roles).toEqual(['ops', 'dev']);

      expect(await estimateRetirement()).toMatchObject({ units: 3, unit: 'rows' });
      expect(await runRetirement()).toEqual({ retired: 3 });

      // The retired cells are NULL; the unconsumed legacy value is untouched.
      expect(await rawRoles('retire-carried')).toBeNull();
      expect(await rawRoles('retire-empty')).toBeNull();
      expect(await rawRoles('retire-null')).toBeNull();
      expect(await rawRoles(granted.id)).toBeNull();
      expect(await rawRoles('retire-unconsumed')).toBe('ops');
      expect(await rawRoleList('retire-unconsumed')).toBeNull();

      // After: a NULL legacy cell beside the array — the ORM still reads the array.
      expect((await db.get(tables.User, { id: 'retire-carried' })).roles).toEqual(['admin']);
      expect((await db.get(tables.User, { id: granted.id })).roles).toEqual(['ops', 'dev']);
      const everyone = await db.query(tables.User, {});
      expect(everyone.find((user) => user.id === granted.id)?.roles).toEqual(['ops', 'dev']);
      expect(everyone.find((user) => user.id === 'retire-carried')?.roles).toEqual(['admin']);

      // Re-run: nothing left to retire.
      expect(await runRetirement()).toEqual({ retired: 0 });
      expect(await estimateRetirement()).toMatchObject({ units: 0, unit: 'rows' });
    } finally {
      await dropTable(tables.User as Table<any>);
      await spannerDriver.getTableManager().loadTable(tables.User);
    }
  }, 120000);

  it('backfills, normalizes, preserves, and re-runs clean on a deployed-shape database', async () => {
    // Simulate the deployed state: the legacy column exists beside the new schema.
    await spannerDriver.runUpdateSchema(`ALTER TABLE ${tables.User.name} ADD COLUMN roles STRING(255)`);

    await rawUserInsert('legacy-admin', 'admin');
    await rawUserInsert('legacy-messy', ' admin, ops ,admin,, dev');
    await rawUserInsert('legacy-empty', '');
    await rawUserInsert('legacy-null', null);
    // Already migrated / post-cutover grant: role_list set, stale legacy value beside it.
    const db = getDbAsSystem();
    const alreadyMigrated = await db.insert(tables.User, {
      name: 'Already migrated',
      email: 'already@test.local',
      password: 'test',
      emailVerified: false,
      roles: ['ops'],
    });
    await spannerDriver.runDml(() => ({
      sql: `UPDATE ${tables.User.name} SET roles = 'admin' WHERE id = '${alreadyMigrated.id}'`,
    }));

    expect(await runMigration()).toEqual({ backfilled: 2 });

    // The ORM (the product's read path) sees typed arrays.
    expect((await db.get(tables.User, { id: 'legacy-admin' })).roles).toEqual(['admin']);
    expect((await db.get(tables.User, { id: 'legacy-messy' })).roles).toEqual(['admin', 'ops', 'dev']);
    // No roles then, no roles now.
    expect(await rawRoleList('legacy-empty')).toBeNull();
    expect(await rawRoleList('legacy-null')).toBeNull();
    // The post-cutover value wins over the stale legacy string.
    expect((await db.get(tables.User, { id: alreadyMigrated.id })).roles).toEqual(['ops']);

    // Re-run: nothing left to do, nothing clobbered.
    expect(await runMigration()).toEqual({ backfilled: 0 });
    expect((await db.get(tables.User, { id: 'legacy-admin' })).roles).toEqual(['admin']);
  }, 120000);
});
