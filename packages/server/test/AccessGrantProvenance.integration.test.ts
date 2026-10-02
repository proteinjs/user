import { Reference, StringColumn, Table, getDb, getDbAsSystem, getTables } from '@proteinjs/db';
import { getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { AccessGrant, SharedRecord, User, getSharedDb, tables, withSharedRecordColumns } from '@proteinjs/user';
import { AccessInvite } from '../src/services/AccessInvite';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

/** A shared record a plain user may read — the resource every invite and grant below hangs on. */
interface ProvenanceNote extends SharedRecord {
  title: string;
}

class ProvenanceNoteTable extends Table<ProvenanceNote> {
  name = 'user_test_provenance_note';
  auth: Table<ProvenanceNote>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<ProvenanceNote>({
    title: new StringColumn('title'),
  });
}

/** The provenance columns as a reader sees them — typed loosely so the suite compiles before the columns exist. */
type Provenance = { createdBy?: Reference<User> | null; grantedBy?: Reference<User> | null };

const testEnv = new UserServerTestEnvironment();
const noteTable = new ProvenanceNoteTable() as Table<ProvenanceNote>;
const dropTestTable = getDropTestTable(testEnv.spannerDriver);

/**
 * WHO CONFERRED A GRANT is a stored fact, never a guess. An access invite remembers the account
 * that minted it (`createdBy`, stamped at the mint from the caller); a grant remembers the account
 * that conferred it (`grantedBy`): an accepted invite's grant carries the invite's MINTER — the
 * person who shared — never the acceptor; a grant a caller inserts directly carries that caller;
 * the grant the system confers with no one behind it (the creator's own owner grant at a shared
 * record's birth) carries nobody.
 *
 * Before these columns the only "who" on an invite was last-accept telemetry on a multi-use link
 * and a grant had principal / resource / level alone — "who sent me this" was unrecoverable.
 */
describe('AccessGrant provenance — the minter on the invite, the granter on the grant', () => {
  let alice: User;
  let bob: User;
  let carol: User;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // Name-based resolution (the accept's final `resource.get()` resolves the table by name) and the schema.
    (getTables() as Table<any>[]).push(noteTable);
    await testEnv.spannerDriver.getTableManager().loadTable(noteTable);
  }, 120_000);

  afterAll(async () => {
    await dropTestTable(noteTable);
    await testEnv.afterAll();
  }, 120_000);

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(noteTable, {});
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.AccessInvite, {});
    await db.delete(tables.User, {});
    alice = await testEnv.createUser({ name: 'Alice Owner', email: 'alice@test.local' });
    bob = await testEnv.createUser({ name: 'Bob Recipient', email: 'bob@test.local' });
    carol = await testEnv.createUser({ name: 'Carol Reader', email: 'carol@test.local' });
  });

  /** Alice's note: the shared-record insert confers her owner grant as system — the real bootstrap. */
  const aliceNote = async (): Promise<ProvenanceNote> => {
    testEnv.actAs(alice);
    return await getSharedDb().insert(noteTable, { title: 'Trip budget' });
  };

  const grantsOf = async (principal: User, note: ProvenanceNote): Promise<(AccessGrant & Provenance)[]> =>
    (await getDbAsSystem().query(tables.AccessGrant, {
      principal: principal.id,
      resource: note.id,
      resourceTable: noteTable.name,
    })) as (AccessGrant & Provenance)[];

  /** `minter` (an owner on the note) mints an invite at `accessLevel` and hands back its token. */
  const mint = async (minter: User, note: ProvenanceNote, accessLevel: AccessGrant['accessLevel']): Promise<string> => {
    testEnv.actAs(minter);
    const { token } = await new AccessInvite().createAccessInvite({
      resourceTable: noteTable.name,
      resourceId: note.id,
      accessLevel,
    });
    return token;
  };

  it('an invite carries the account that minted it', async () => {
    const note = await aliceNote();
    const token = await mint(alice, note, 'read');

    const invite = (await getDbAsSystem().get(tables.AccessInvite, { token })) as Provenance;
    expect(invite.createdBy?._id).toBe(alice.id);
  });

  it("an accepted invite's grant carries the invite's minter as grantedBy — the sharer, never the acceptor", async () => {
    const note = await aliceNote();
    const token = await mint(alice, note, 'read');

    testEnv.actAs(bob);
    await new AccessInvite().acceptAccessInvite(token);

    const [grant] = await grantsOf(bob, note);
    expect(grant.accessLevel).toBe('read');
    expect(grant.grantedBy?._id).toBe(alice.id);
    expect(grant.grantedBy?._id).not.toBe(bob.id);
  });

  it('an upgrade through a higher invite restamps the grant with that invite’s minter', async () => {
    const note = await aliceNote();
    const readToken = await mint(alice, note, 'read');
    testEnv.actAs(bob);
    await new AccessInvite().acceptAccessInvite(readToken);

    // A second owner mints the write link; Bob's upgrade through it names that minter.
    testEnv.actAs(alice);
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference<User>(tables.User.name, carol.id),
      resource: new Reference<ProvenanceNote>(noteTable.name, note.id),
      resourceTable: noteTable.name,
      accessLevel: 'owner',
    });
    const writeToken = await mint(carol, note, 'write');
    testEnv.actAs(bob);
    await new AccessInvite().acceptAccessInvite(writeToken);

    const grants = await grantsOf(bob, note);
    expect(grants).toHaveLength(1);
    expect(grants[0].accessLevel).toBe('write');
    expect(grants[0].grantedBy?._id).toBe(carol.id);
  });

  it('a grant a caller confers directly carries that caller', async () => {
    const note = await aliceNote();
    testEnv.actAs(alice);
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference<User>(tables.User.name, carol.id),
      resource: new Reference<ProvenanceNote>(noteTable.name, note.id),
      resourceTable: noteTable.name,
      accessLevel: 'read',
    });

    const [grant] = await grantsOf(carol, note);
    expect(grant.grantedBy?._id).toBe(alice.id);
  });

  it("the creator's own owner grant — conferred by the system at the record's birth — carries no granter", async () => {
    const note = await aliceNote();

    const [grant] = await grantsOf(alice, note);
    expect(grant.accessLevel).toBe('owner');
    expect(grant.grantedBy?._id ?? undefined).toBeUndefined();
  });
});
