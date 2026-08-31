import {
  DataEncryptionKeyTable,
  DataKeyStore,
  EncryptedColumns,
  EncryptionEnvelope,
  InMemoryMasterKeyProvider,
  QueryBuilder,
  Reference,
  StringColumn,
  Table,
  getDb,
  getDbAsSystem,
  getTables,
  setDbEncryptionConfig,
} from '@proteinjs/db';
import type { DataEncryptionKey } from '@proteinjs/db';
import { getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import {
  AccessGrant,
  SharedRecord,
  SharedScopeKeyOwners,
  User,
  getSharedDb,
  getSharedDbWithOverride,
  tables,
  withSharedRecordColumns,
} from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

/**
 * Share-with-support MVP — encrypted rows in SHARED permission scopes
 * (TRUST_AND_COMPLIANCE §4/§4.4; SHARING_EXPANSION §3). Outcomes asserted against the
 * emulator: envelopes at rest, rows readable/searchable per principal — never calls made.
 *
 * The mechanism under test is `SharedScopeKeyOwners` composed into `DbEncryptionConfig`:
 * - rows key by the SCOPE-ROOT OWNER (a contributor's write keys under the document owner);
 * - a share grant extends decrypt + blind-index search to the recipient (support = an
 *   ordinary read grant — the §4.4 path is structurally just a share);
 * - revocation ends access with NO re-encryption (keys are not access control);
 * - owner key rotation and crypto-shred honor the same owner axis.
 */

interface EncSharedNote extends SharedRecord {
  title?: string | null; // encrypted + contains search
  label?: string | null; // encrypted + equality lookup
  body?: string | null; // encrypted, never queried by value
  kind?: string | null; // plaintext metadata
}

class EncSharedNoteTable extends Table<EncSharedNote> {
  name = 'user_test_enc_shared_note';
  auth: Table<EncSharedNote>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<EncSharedNote>({
    title: new StringColumn('title', { encrypted: { searchable: 'contains' } }),
    label: new StringColumn('label', { encrypted: { searchable: 'equality' } }),
    body: new StringColumn('body', { encrypted: {} }, 'MAX'),
    kind: new StringColumn('kind', { encrypted: false }),
  });
}

const testEnv = new UserServerTestEnvironment();
const noteTable = new EncSharedNoteTable() as Table<EncSharedNote>;
const keyOwners = new SharedScopeKeyOwners();
const envelope = new EncryptionEnvelope();

const rawColumn = async (id: string, columnName: string): Promise<any> => {
  const rows = await testEnv.spannerDriver.runQuery(() => ({
    sql: `SELECT \`${columnName}\` FROM \`${noteTable.name}\` WHERE \`id\` = '${id}'`,
  }));
  return rows[0]?.[columnName];
};

const titleLike = (pattern: string) =>
  new QueryBuilder<EncSharedNote>(noteTable.name).condition({ field: 'title', operator: 'LIKE', value: pattern });

const clearResolvedOwnerCache = () => {
  ((globalThis as any)['__proteinjs_user_sharedScopeOwnerCache'] as Map<string, unknown> | undefined)?.clear();
};

describe('Shared-scope encryption: owner-keyed scopes, share/revoke, support path', () => {
  const dropTestTable = getDropTestTable(testEnv.spannerDriver);
  let owner: User; // O — creates the document
  let writer: User; // W — write-grant contributor
  let support: User; // S — the §4.4 support principal (read grant via the help flow)
  let stranger: User; // X — never granted
  let coOwner: User; // C — conferred owner (owner-ceiling path)
  let root: EncSharedNote;
  let supportGrantId: string;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // Register the suite's table for name-based resolution (statement generation and the
    // derived token-table subqueries resolve through `tableByName`), then create the
    // physical schema: the framework's key table + the note table (its token table and
    // companion columns ride the same load).
    (getTables() as Table<any>[]).push(noteTable);
    const tableManager = testEnv.spannerDriver.getTableManager();
    await tableManager.loadTable(new DataEncryptionKeyTable());
    await tableManager.loadTable(noteTable);

    setDbEncryptionConfig({
      masterKeyProvider: new InMemoryMasterKeyProvider('shared-scope-encryption-test'),
      resolveKeyOwner: (args) => keyOwners.resolveKeyOwner(args),
      getAccessibleKeyOwners: (args) => keyOwners.getAccessibleKeyOwners(args),
    });

    const db = getDbAsSystem();
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.User, {});
    await db.delete(new DataEncryptionKeyTable(), {});
    clearResolvedOwnerCache();

    owner = await testEnv.createUser({ name: 'Enc Owner', email: 'enc-owner@test.local' });
    writer = await testEnv.createUser({ name: 'Enc Writer', email: 'enc-writer@test.local' });
    support = await testEnv.createUser({ name: 'Enc Support', email: 'enc-support@test.local' });
    stranger = await testEnv.createUser({ name: 'Enc Stranger', email: 'enc-stranger@test.local' });
    coOwner = await testEnv.createUser({ name: 'Enc CoOwner', email: 'enc-coowner@test.local' });
  }, 180000);

  afterAll(async () => {
    setDbEncryptionConfig(undefined);
    clearResolvedOwnerCache();
    await dropTestTable(new EncryptedColumns().tokenTableFor(noteTable)!);
    await dropTestTable(noteTable);
    await dropTestTable(new DataEncryptionKeyTable());
    await testEnv.afterAll();
  }, 120000);

  test('root birth: the creator keys the scope — ciphertext at rest names the owner', async () => {
    testEnv.actAs(owner);
    root = await getSharedDb().insert(noteTable, {
      title: 'Therapy notes shared scope',
      label: 'case-407',
      body: 'The sensitive body text',
      kind: 'note',
    });

    // At rest: self-describing envelopes named by O (resolved at insert time, BEFORE the
    // owner grant lands post-DML), no plaintext anywhere, metadata untouched.
    for (const columnName of ['title', 'label', 'body']) {
      const stored = await rawColumn(root.id, columnName);
      expect(envelope.isEnvelope(stored)).toBe(true);
      expect(String(stored)).not.toContain('Therapy');
      expect(String(stored)).not.toContain('sensitive');
      expect(envelope.parse(stored)!.owner).toBe(owner.id);
    }
    expect(await rawColumn(root.id, 'kind')).toBe('note');

    // The owner grant the birth pre-resolved is now the authoritative record.
    const grants = await getDbAsSystem<AccessGrant>().query(
      tables.AccessGrant,
      new QueryBuilder<AccessGrant>(tables.AccessGrant.name)
        .condition({ field: 'resource', operator: '=', value: root.id })
        .condition({ field: 'accessLevel', operator: '=', value: 'owner' })
    );
    expect(grants.map((grant) => grant.principal?._id)).toEqual([owner.id]);

    // One data key exists, and it is O's.
    const keyRows = await getDbAsSystem<DataEncryptionKey>().query(new DataEncryptionKeyTable(), {});
    expect(keyRows.map((row) => row.owner)).toEqual([owner.id]);

    // The owner reads plaintext back.
    const fetched = await getSharedDb().get(noteTable, { id: root.id });
    expect(fetched!.title).toBe('Therapy notes shared scope');
    expect(fetched!.body).toBe('The sensitive body text');
  });

  test('share with support: a read grant extends decrypt + search to the recipient (§4.4)', async () => {
    // O performs the share — an ordinary direct grant, exactly what the help-flow
    // affordance will mint. Caller-context: the grant table's own gate admits O (owner).
    testEnv.actAs(owner);
    const supportGrant = await getDb<AccessGrant>().insert(tables.AccessGrant, {
      principal: new Reference(tables.User.name, support.id),
      resource: new Reference(noteTable.name, root.id),
      resourceTable: noteTable.name,
      accessLevel: 'read',
    });
    supportGrantId = supportGrant.id;

    testEnv.actAs(support);
    const fetched = await getSharedDb().get(noteTable, { id: root.id });
    expect(fetched!.title).toBe('Therapy notes shared scope');
    expect(fetched!.body).toBe('The sensitive body text');

    // Blind-index fan-out: S's contains-search fingerprints under O's index key and finds
    // the shared document; equality rides the fingerprint companion the same way.
    const found = await getSharedDb().query(noteTable, titleLike('%Therapy notes%'));
    expect(found.map((row) => row.id)).toEqual([root.id]);
    const byLabel = await getSharedDb().query(noteTable, { label: 'case-407' } as Partial<EncSharedNote>);
    expect(byLabel.map((row) => row.id)).toEqual([root.id]);

    // Reading and searching mint NO key for the recipient — keys are created on write only.
    const supportKeys = await getDbAsSystem<DataEncryptionKey>().query(new DataEncryptionKeyTable(), {
      owner: support.id,
    } as Partial<DataEncryptionKey>);
    expect(supportKeys.length).toBe(0);
  });

  test('a stranger sees nothing: no rows, and search covers only their own (empty) key set', async () => {
    testEnv.actAs(stranger);
    expect(await getSharedDb().get(noteTable, { id: root.id })).toBeUndefined();
    expect(await getSharedDb().query(noteTable, titleLike('%Therapy%'))).toEqual([]);
    expect(await keyOwners.getAccessibleKeyOwners({ runAsSystem: false })).toEqual([stranger.id]);
  });

  test("a contributor's write into the shared scope keys under the DOCUMENT owner, not the writer", async () => {
    testEnv.actAs(owner);
    await getDb<AccessGrant>().insert(tables.AccessGrant, {
      principal: new Reference(tables.User.name, writer.id),
      resource: new Reference(noteTable.name, root.id),
      resourceTable: noteTable.name,
      accessLevel: 'write',
    });

    // Fresh resolution (no cache): the write must derive the owner from the GRANT record.
    clearResolvedOwnerCache();
    testEnv.actAs(writer);
    const child = await getSharedDbWithOverride().insert(noteTable, {
      title: 'Contributor note addendum line',
      label: 'addendum',
      body: null,
      kind: 'note',
      permissionSource: new Reference(noteTable.name, root.id),
    });

    // The crypto-shred agreement: W's row inside O's document is O-keyed — exactly the row
    // set the account-deletion purge walker drains by O's owned permission sources.
    const stored = await rawColumn(child.id, 'title');
    expect(envelope.isEnvelope(stored)).toBe(true);
    expect(envelope.parse(stored)!.owner).toBe(owner.id);
    expect(envelope.parse(stored)!.owner).not.toBe(writer.id);

    // And W's own separate document stays W-keyed (the default self-scope).
    const own = await getSharedDb().insert(noteTable, {
      title: 'Writer private note planning',
      label: 'own',
      body: null,
      kind: 'note',
    });
    expect(envelope.parse(await rawColumn(own.id, 'title'))!.owner).toBe(writer.id);

    // W's search spans both scopes in one query: their own key AND O's (the shared scope).
    const lineRows = await getSharedDb().query(noteTable, titleLike('%addendum line%'));
    expect(lineRows.map((row) => row.title)).toEqual(['Contributor note addendum line']);
    const noteRows = await getSharedDb().query(noteTable, titleLike('%note%'));
    expect(noteRows.map((row) => row.title).sort()).toEqual([
      'Contributor note addendum line',
      'Therapy notes shared scope',
      'Writer private note planning',
    ]);
  });

  test('owner key rotation honors shares: old and new envelopes both decrypt and search for the recipient', async () => {
    const newVersion = await new DataKeyStore().rotateKey(owner.id);
    expect(newVersion).toBe(2);

    testEnv.actAs(owner);
    const rotated = await getSharedDbWithOverride().insert(noteTable, {
      title: 'Post-rotation Therapy addendum',
      label: 'rotated',
      body: null,
      kind: 'note',
      permissionSource: new Reference(noteTable.name, root.id),
    });
    expect(envelope.parse(await rawColumn(rotated.id, 'title'))!.version).toBe(2);
    expect(envelope.parse(await rawColumn(root.id, 'title'))!.version).toBe(1);

    testEnv.actAs(support);
    const fetchedOld = await getSharedDb().get(noteTable, { id: root.id });
    const fetchedNew = await getSharedDb().get(noteTable, { id: rotated.id });
    expect(fetchedOld!.title).toBe('Therapy notes shared scope');
    expect(fetchedNew!.title).toBe('Post-rotation Therapy addendum');

    const lower = await getSharedDb().query(noteTable, titleLike('%therapy%'));
    expect(lower.length).toBe(0); // LIKE stays case-exact over encrypted values
    const both = await getSharedDb().query(noteTable, titleLike('%Therapy%'));
    expect(both.map((row) => row.id).sort()).toEqual([root.id, rotated.id].sort());
  });

  test('conferred co-ownership: the scope keeps keying by its ORIGINAL owner, and the co-owner searches it', async () => {
    testEnv.actAs(owner);
    await getDb<AccessGrant>().insert(tables.AccessGrant, {
      principal: new Reference(tables.User.name, coOwner.id),
      resource: new Reference(noteTable.name, root.id),
      resourceTable: noteTable.name,
      accessLevel: 'owner', // legal: O holds owner (the owner-ceiling path)
    });

    // Fresh resolution (no cache): the EARLIEST owner grant — O's — still keys new writes.
    clearResolvedOwnerCache();
    testEnv.actAs(coOwner);
    const coWrite = await getSharedDbWithOverride().insert(noteTable, {
      title: 'Co-owner amendment entry',
      label: 'co-owner',
      body: null,
      kind: 'note',
      permissionSource: new Reference(noteTable.name, root.id),
    });
    expect(envelope.parse(await rawColumn(coWrite.id, 'title'))!.owner).toBe(owner.id);

    // The co-owner's accessible set includes O — an owner-level inbound grant is still
    // someone sharing content into their view.
    const accessible = await keyOwners.getAccessibleKeyOwners({ runAsSystem: false });
    expect(accessible.sort()).toEqual([coOwner.id, owner.id].sort());
    const found = await getSharedDb().query(noteTable, titleLike('%amendment%'));
    expect(found.map((row) => row.id)).toEqual([coWrite.id]);
  });

  test('revocation ends access and fan-out immediately — with NO re-encryption', async () => {
    const cipherBefore = await rawColumn(root.id, 'title');

    testEnv.actAs(owner);
    const revoked = await getDb().delete(tables.AccessGrant, { id: supportGrantId });
    expect(revoked).toBe(1);

    testEnv.actAs(support);
    expect(await getSharedDb().get(noteTable, { id: root.id })).toBeUndefined();
    expect(await getSharedDb().query(noteTable, titleLike('%Therapy%'))).toEqual([]);
    expect(await keyOwners.getAccessibleKeyOwners({ runAsSystem: false })).toEqual([support.id]);

    // Keys are not access control: the row's ciphertext is byte-identical — revocation is
    // the permission layer's act, never a re-encryption.
    expect(await rawColumn(root.id, 'title')).toBe(cipherBefore);
  });

  test('system reads decrypt without caller context — the compliance-decrypt seam composes', async () => {
    // The §4.5 tool's exact read shape: one system get by id. No accessible-owner set is
    // consulted; the envelope names its key.
    const fetched = await getDbAsSystem<EncSharedNote>().get(noteTable, { id: root.id });
    expect(fetched!.title).toBe('Therapy notes shared scope');
    expect(fetched!.body).toBe('The sensitive body text');
  });

  test('system searches cover EVERY key owner — an unscoped query never silently misses a scope', async () => {
    const rows = await getDbAsSystem<EncSharedNote>().query(noteTable, titleLike('%note%'));
    const rowOwners = new Set<string>();
    for (const row of rows) {
      rowOwners.add(envelope.parse(await rawColumn(row.id, 'title'))!.owner);
    }
    // Spans O's scope AND W's private document — both key owners covered in one query.
    expect(rowOwners.has(owner.id)).toBe(true);
    expect(rowOwners.has(writer.id)).toBe(true);
  });

  test('the resolver contract: non-shared tables fall through; caller-less searches refuse loudly', async () => {
    expect(await keyOwners.resolveKeyOwner({ table: tables.User, record: owner })).toBeUndefined();

    testEnv.actAs({} as User);
    await expect(keyOwners.getAccessibleKeyOwners({ runAsSystem: false })).rejects.toThrow(/without a caller identity/);
    testEnv.actAs(owner);
  });

  test('crypto-shred: deleting the owner keys makes every envelope in the scope permanently unreadable', async () => {
    const deleted = await new DataKeyStore().shredOwnerKeys(owner.id);
    expect(deleted).toBeGreaterThanOrEqual(2); // v1 + v2
    await expect(getDbAsSystem<EncSharedNote>().get(noteTable, { id: root.id })).rejects.toThrow(
      /No data key exists for owner/
    );
  });
});
