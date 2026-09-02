import { Table } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { BackfillUserStatusActive } from '../src/migrations/BackfillUserStatusActive';

/**
 * The user.status legacy-null retirement against a real Spanner emulator, simulating a deployed
 * database: rows written before the status column existed read NULL — the standing every gate
 * treats as active, but the stored state said nothing (the founder's v1.22 admin-review finding:
 * active accounts showing no status on the user table).
 *
 * Pinned outcomes:
 * - NULL-status rows become an explicit 'active'
 * - an explicit 'deactivated' is NEVER touched (the one standing that must survive)
 * - an explicit 'active' stays as-is
 * - re-runs are clean no-ops (idempotent by shape: a write makes the row unmatchable)
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

const runMigration = async () => await new BackfillUserStatusActive().record.run();

/** A pre-status-column row, exactly as deployed databases hold them: status NULL. */
const rawLegacyUserInsert = async (id: string) => {
  await spannerDriver.runDml(() => ({
    sql:
      `INSERT INTO ${tables.User.name} (id, name, email, password, email_verified, created, updated) ` +
      `VALUES ('${id}', 'User ${id}', '${id}@test.local', 'test', false, ` +
      `CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
  }));
};

const rawStatusUpdate = async (id: string, status: string) => {
  await spannerDriver.runDml(() => ({
    sql: `UPDATE ${tables.User.name} SET status = '${status}' WHERE id = '${id}'`,
  }));
};

const rawStatus = async (id: string) =>
  (
    (await spannerDriver.runQuery(() => ({
      sql: `SELECT status FROM ${tables.User.name} WHERE id = '${id}'`,
    }))) as unknown as Array<{ status: string | null }>
  )[0].status;

describe('BackfillUserStatusActive — legacy NULL status → explicit active', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [new DbDriverFactory()];

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

  it('backfills legacy NULLs, never touches explicit standings, re-runs clean', async () => {
    await rawLegacyUserInsert('legacy-null-1');
    await rawLegacyUserInsert('legacy-null-2');
    await rawLegacyUserInsert('explicit-active');
    await rawStatusUpdate('explicit-active', 'active');
    await rawLegacyUserInsert('deactivated-user');
    await rawStatusUpdate('deactivated-user', 'deactivated');

    expect(await runMigration()).toEqual({ backfilled: 2 });

    expect(await rawStatus('legacy-null-1')).toBe('active');
    expect(await rawStatus('legacy-null-2')).toBe('active');
    expect(await rawStatus('explicit-active')).toBe('active');
    // The one standing that must survive a representation fix.
    expect(await rawStatus('deactivated-user')).toBe('deactivated');

    // Re-run: nothing left to match.
    expect(await runMigration()).toEqual({ backfilled: 0 });
    expect(await rawStatus('deactivated-user')).toBe('deactivated');
  }, 120000);
});
