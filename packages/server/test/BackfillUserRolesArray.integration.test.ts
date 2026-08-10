import { Db, Table, getDbAsSystem } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { BackfillUserRolesArray } from '../src/migrations/BackfillUserRolesArray';

/**
 * The user.roles cutover migration against a real Spanner emulator, simulating a deployed
 * database: the user table carries the NEW schema (role_list, added by schema sync) PLUS the
 * legacy comma-string `roles` column with pre-cutover data — exactly the state a deployment is
 * in when the migration runs.
 *
 * Pinned outcomes:
 * - legacy comma strings land in role_list as normalized arrays (trim, drop empties, dedupe)
 * - empty/NULL legacy values stay untouched (no roles then, no roles now)
 * - rows already carrying role_list are never clobbered (idempotence / post-cutover grants win)
 * - a database that never had the legacy column (fresh install) is a clean no-op
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
  }, 60000);

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
