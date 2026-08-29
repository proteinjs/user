import { getDb, getDbAsSystem, Reference, ReferenceColumn } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { AccessGrant, tables, User } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

/**
 * AccessGrant.principal is a REFERENCE to the `user` table (the 2026-08 declaration bug: the
 * column named its reference table `UserTable.name` — the class's static JS name, `'UserTable'` —
 * not the table's declared name `'user'`).
 *
 * PREMISE (why the fix is declaration-only): `ReferenceColumn.serialize` stores the bare id —
 * the reference's table name lives ONLY in the column declaration, which `deserialize` stamps
 * onto every read-back `Reference`. The first test asserts that against the live emulator: the
 * raw stored `principal` cell is exactly the principal's user id. Zero data is touched by the
 * fix and the schema sync sees no change (same STRING(36) column either way).
 *
 * SURFACE: `grant.principal.get()` resolves through `tableByName(reference._table)` — with the
 * class name stamped on it, resolution throws `Unable to find table: UserTable`, so the admin
 * grant table could never render principals as linked names (db-ui's ReferenceCellValue rides
 * this same `Reference.get()`; the ui-package suite binds that rendering surface).
 *
 * NON-REGRESSION: the grant machinery itself compares stored PRINCIPAL IDS, never the
 * declaration's table name — the admin/owner insert gate must behave identically before and
 * after the fix (pinned by the caller-context legs).
 */
describe('AccessGrant.principal reference — stored bare ids; declaration resolves the user table', () => {
  let alice: User;
  let admin: User;
  let stranger: User;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // Reference.get() resolves tables by NAME off the source graph (not loaded in tests) —
    // register exactly this package's tables, as the app's composition would.
    objectCache()['@proteinjs/db/Table'] = Object.values(tables);
  }, 120_000);

  afterAll(async () => {
    delete objectCache()['@proteinjs/db/Table'];
    await testEnv.afterAll();
  }, 60_000);

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.User, {});
    alice = await testEnv.createUser({ name: 'Alice Principal', email: 'alice@test.local' });
    admin = await testEnv.createUser({ name: 'Ada Admin', email: 'admin@test.local', roles: ['admin'] });
    stranger = await testEnv.createUser({ name: 'Sam Stranger', email: 'stranger@test.local' });
  });

  /** A system-conferred grant for `principal` on `resource` (the SharedRecord-bootstrap shape). */
  const conferGrant = async (
    principal: User,
    resource: User,
    accessLevel: AccessGrant['accessLevel']
  ): Promise<AccessGrant> =>
    await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference<User>(tables.User.name, principal.id),
      resource: new Reference<User>(tables.User.name, resource.id),
      resourceTable: tables.User.name,
      accessLevel,
    });

  it('PREMISE: the stored principal cell is the bare user id — the table name lives only in the declaration', async () => {
    const grant = await conferGrant(alice, alice, 'owner');

    const rawRows = await testEnv.spannerDriver.runQuery((() => ({
      sql: `SELECT principal, resource, resource_table FROM access_grant WHERE id = '${grant.id}'`,
    })) as Parameters<typeof testEnv.spannerDriver.runQuery>[0]);

    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].principal).toBe(alice.id);
    expect(rawRows[0].resource).toBe(alice.id);
    expect(rawRows[0].resource_table).toBe('user');
    // Nothing 'UserTable'-shaped is stored anywhere in the row's reference cells.
    expect(JSON.stringify(rawRows[0])).not.toContain('UserTable');
  });

  it('a read-back grant principal carries the user table name and resolves the user record', async () => {
    const inserted = await conferGrant(alice, alice, 'owner');

    const grant = await getDbAsSystem().get(tables.AccessGrant, { id: inserted.id });
    expect(grant.principal._id).toBe(alice.id);
    // The read-back reference's table comes from the COLUMN DECLARATION (deserialize) — this is
    // the line under test: 'UserTable' here means the class name leaked into the declaration.
    expect(grant.principal._table).toBe('user');

    // The admin-surface consumer's path: resolve the principal by reference, as the admin.
    testEnv.actAs(admin);
    const principalUser = await grant.principal.get();
    expect(principalUser).toMatchObject({ id: alice.id, name: 'Alice Principal' });
  });

  it('NON-REGRESSION: the admin/owner insert gate still keys on stored principal ids', async () => {
    await conferGrant(admin, alice, 'owner');

    // The owner confers read to another user through the caller-context path — the gate finds
    // the caller's own grant by principal-ID equality against the stored rows.
    testEnv.actAs(admin);
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference<User>(tables.User.name, stranger.id),
      resource: new Reference<User>(tables.User.name, alice.id),
      resourceTable: tables.User.name,
      accessLevel: 'read',
    });

    const grants = await getDbAsSystem().query(tables.AccessGrant, { resource: alice.id });
    expect(grants.map((grant) => ({ principal: grant.principal._id, accessLevel: grant.accessLevel }))).toEqual(
      expect.arrayContaining([
        { principal: admin.id, accessLevel: 'owner' },
        { principal: stranger.id, accessLevel: 'read' },
      ])
    );

    // A caller with NO grant on the resource is still refused.
    testEnv.actAs(stranger);
    await expect(
      getDb().insert(tables.AccessGrant, {
        principal: new Reference<User>(tables.User.name, stranger.id),
        resource: new Reference<User>(tables.User.name, alice.id),
        resourceTable: tables.User.name,
        accessLevel: 'admin',
      })
    ).rejects.toThrow('User does not have admin access to resource');
  });
});
