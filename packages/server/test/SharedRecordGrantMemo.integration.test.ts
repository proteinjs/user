import { Db, Reference, StringColumn, Table, getDb, getDbAsSystem, getTables } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { SourceRepository } from '@proteinjs/reflection';
import { SharedRecord, User, getSharedDb, tables, withSharedRecordColumns } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

interface SharedNote extends SharedRecord {
  title?: string | null;
}

class SharedNoteTable extends Table<SharedNote> {
  name = 'user_test_shared_note_grant_memo';
  auth: Table<SharedNote>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<SharedNote>({
    title: new StringColumn('title'),
  });
}

const testEnv = new UserServerTestEnvironment();
const noteTable = new SharedNoteTable() as Table<SharedNote>;

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };

/**
 * The shared-record insert guard asks the caller's grant on the permission source ONCE PER
 * TRANSACTION per scope, not once per row: a transaction that attaches many rows to one scope — a
 * multi-row insert of a subtree, several child rows in one unit — proves the grant with one grant-table
 * read and reuses it for every later row. Outside a transaction every insert still asks (nothing is
 * remembered across requests), and a caller with no grant is refused on the first row inside a
 * transaction exactly as before — the memo only ever shortens a proof it has already made.
 */
describe('SharedRecord insert guard — one grant read per scope per transaction', () => {
  const dropTestTable = getDropTestTable(testEnv.spannerDriver);
  let owner: User;
  let stranger: User;
  let root: SharedNote;

  /** The grant-table reads a window makes, counted at the db layer (every guard ask is one query). */
  const grantReadsDuring = async <T>(act: () => Promise<T>): Promise<{ result: T; grantReads: number }> => {
    const query = jest.spyOn(Db.prototype, 'query');
    try {
      const result = await act();
      const grantReads = query.mock.calls.filter(([table]) => table.name === tables.AccessGrant.name).length;
      return { result, grantReads };
    } finally {
      query.mockRestore();
    }
  };

  const childRow = (n: number): SharedNote =>
    ({
      title: `child ${n}`,
      permissionSource: new Reference(noteTable.name, root.id),
      permissionSourceTable: noteTable.name,
    }) as SharedNote;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // The ambient transaction context the db's runTransaction seeds and the guard reads (the
    // generated source graph is not loaded under jest, so the implementation is seeded by hand).
    (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache[
      '@proteinjs/db/DefaultTransactionContextFactory'
    ] = [new TransactionContext()];
    (getTables() as Table<any>[]).push(noteTable);
    await testEnv.spannerDriver.getTableManager().loadTable(noteTable);
    const db = getDbAsSystem();
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.User, {});
    owner = await testEnv.createUser({ name: 'Memo Owner', email: 'memo-owner@test.local' });
    stranger = await testEnv.createUser({ name: 'Memo Stranger', email: 'memo-stranger@test.local' });
    // The scope root, born as the owner: the framework confers the owner grant after the insert.
    testEnv.actAs(owner);
    root = await getSharedDb().insert(noteTable, { title: 'the document' } as SharedNote);
  }, 180000);

  afterAll(async () => {
    await dropTestTable(noteTable);
    await testEnv.afterAll();
  }, 120000);

  test('five rows attached to one scope in one transaction: one grant read, five rows landed', async () => {
    testEnv.actAs(owner);
    const { grantReads } = await grantReadsDuring(() =>
      getDb().runTransaction(async () => {
        for (let n = 1; n <= 5; n++) {
          await getSharedDb().insert(noteTable, childRow(n));
        }
      })
    );
    expect(grantReads).toBe(1);
    const landed = await getDbAsSystem().query(noteTable, { permissionSource: root.id });
    expect(
      landed
        .filter((row) => row.title?.startsWith('child '))
        .map((row) => row.title)
        .sort()
    ).toEqual(['child 1', 'child 2', 'child 3', 'child 4', 'child 5']);
  });

  test('outside a transaction every insert asks: three lone inserts, three grant reads', async () => {
    testEnv.actAs(owner);
    const { grantReads } = await grantReadsDuring(async () => {
      for (let n = 9; n <= 11; n++) {
        await getSharedDb().insert(noteTable, childRow(n));
      }
    });
    expect(grantReads).toBe(3);
  });

  test('a caller with no grant is refused on the first row inside a transaction; nothing lands', async () => {
    testEnv.actAs(stranger);
    const before = (await getDbAsSystem().query(noteTable, { permissionSource: root.id })).length;
    await expect(
      getDb().runTransaction(async () => {
        await getSharedDb().insert(noteTable, childRow(12));
        await getSharedDb().insert(noteTable, childRow(13));
      })
    ).rejects.toThrow(/does not have write access/);
    const after = (await getDbAsSystem().query(noteTable, { permissionSource: root.id })).length;
    expect(after).toBe(before);
  });
});
