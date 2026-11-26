import { UserRepo } from '../src/UserRepo';

import moment from 'moment';
import {
  Db,
  DbDriver,
  getDb,
  getDbAsSystem,
  ObjectColumn,
  QueryBuilderFactory,
  Reference,
  ReferenceArray,
  ReferenceArrayColumn,
  StringColumn,
  Table,
  TableServiceAuth,
} from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import {
  getSharedDb,
  getSharedDbAsSystem,
  setSkipAccessGrants,
  SharedRecord,
  withSharedRecordColumns,
} from '../src/SharedRecord';
import { AccessGrant, AccessGrantTable } from '../src/tables/AccessGrantTable';
import { AccessInvite, AccessInviteTable } from '../src/tables/AccessInviteTable';
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
  /** ReferenceArrayColumn — exercises the updateArrayMembership write shape. */
  related?: ReferenceArray<SharedItem>;
  /** Plain-JSON ObjectColumn — exercises the updatePreserving write shape. */
  meta?: any;
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
    related: new ReferenceArrayColumn<SharedItem>('related', 'user_test_shared_item', false),
    meta: new ObjectColumn<any>('meta'),
  });
}

/** A row that takes its permission from a SharedItem: the shape of a table whose rows hang on another table's. */
export interface SharedNote extends SharedRecord {
  text: string;
}

export class SharedNoteTable extends Table<SharedNote> {
  name = 'user_test_shared_note';
  auth: Table<SharedNote>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<SharedNote>(
    { text: new StringColumn('text') },
    { permissionSourceTableName: 'user_test_shared_item' }
  );
}

const dbDriver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
const userRepo = new UserRepo();
const sharedItemTable = new SharedItemTable() as Table<SharedItem>;
const sharedNoteTable = new SharedNoteTable() as Table<SharedNote>;

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
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [
      tables.AccessGrant,
      tables.AccessInvite,
      sharedItemTable,
      sharedNoteTable,
    ];
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
    await dbDriver.getTableManager().loadTable(sharedNoteTable);
    await dbDriver.getTableManager().loadTable(tables.AccessGrant);
    await dbDriver.getTableManager().loadTable(tables.AccessInvite);
  });

  afterEach(async () => {
    await dropTable(sharedItemTable);
    await dropTable(sharedNoteTable);
    await dropTable(new AccessGrantTable());
    await dropTable(new AccessInviteTable());
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

  it('DEFECT 3 — a read holder updateArrayMembership is a typed refusal, not a silent 0', async () => {
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
      await getSharedDb().updateArrayMembership(sharedItemTable, {
        recordId: item.id,
        columnPropertyName: 'related',
        ops: [{ op: 'add', id: 'some-ref-id', afterId: null }],
      });
    } catch (e) {
      caught = e;
    }
    // Before the fix this bailed with a silent `return 0` (row filtered out by the write scope),
    // indistinguishable from a legit no-op. It must now surface the same typed refusal as update.
    expect(caught?.name).toBe('RecordAccessError');

    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: item.id });
    expect(persisted?.related?._ids ?? []).toEqual([]);
  });

  it('DEFECT 3 — a read holder updatePreserving is a typed refusal, not a silent 0', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'original', meta: { a: 1 } });
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, item.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'read',
    });

    runAs(1);
    let caught: any;
    try {
      await getSharedDb().updatePreserving(sharedItemTable, { id: item.id, meta: { a: 2 } } as Partial<SharedItem>, [
        { columnPropertyName: 'meta', paths: ['a'] },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught?.name).toBe('RecordAccessError');

    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: item.id });
    expect(persisted?.meta).toEqual({ a: 1 });
  });

  it('DEFECT 3 — a write holder updateArrayMembership is NOT mis-flagged (positive path)', async () => {
    runAs(0);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'original' });
    await getDb().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(sharedItemTable.name, item.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'write',
    });

    runAs(1);
    await getSharedDb().updateArrayMembership(sharedItemTable, {
      recordId: item.id,
      columnPropertyName: 'related',
      ops: [{ op: 'add', id: 'ref-a', afterId: null }],
    });
    const persisted = await getSharedDbAsSystem().get(sharedItemTable, { id: item.id });
    expect(persisted?.related?._ids ?? []).toEqual(['ref-a']);
  });

  // ————————————————————————————————— AN INVITE'S ROW —————————————————————————————————

  it("an access invite's row at the table's own doors: a signed-in caller's own Db mints through the mint's check, and the break-glass admin's also reads; nobody's changes or removes; the table service's gate admits the admin's reads and nothing more", async () => {
    runAs(0);
    const item = await getSharedDb().insert(sharedItemTable, { name: 'user0 doc' });
    /** A mint as the invite service makes one: an insert through the caller's own Db. */
    const mint = async () =>
      await getDb().insert(tables.AccessInvite, {
        resource: new Reference(sharedItemTable.name, item.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'read',
        tokenExpiresAt: moment().add(7, 'days'),
      } as Partial<AccessInvite> as AccessInvite);
    const asAdmin = () => userRepo.setUser({ ...users[2], roles: ['admin'] });
    const callers: [string, () => void, boolean][] = [
      ['a person who holds nothing on the resource', () => runAs(1), false],
      ['the minter', () => runAs(0), false],
      // A role that is not the admin's reads nothing: the read is the break-glass admin's alone.
      ['a person with another role', () => userRepo.setUser({ ...users[2], roles: ['people-desk'] }), false],
      ['the break-glass admin', asAdmin, true],
    ];
    const roads: [string, 'reads' | 'writes', (invite: AccessInvite) => Promise<unknown>][] = [
      ['a read', 'reads', () => getDb().query(tables.AccessInvite, {})],
      ['a read by id', 'reads', (invite) => getDb().get(tables.AccessInvite, { id: invite.id })],
      ['a count', 'reads', () => getDb().getRowCount(tables.AccessInvite)],
      ['a change', 'writes', (invite) => getDb().update(tables.AccessInvite, { id: invite.id, accessLevel: 'write' })],
      ['a removal', 'writes', (invite) => getDb().delete(tables.AccessInvite, { id: invite.id })],
    ];

    // Each caller on each road, one invite a try: what the caller is told, and whether the row stands as minted.
    // A read is the admin's alone; a change and a removal are nobody's but the system's.
    const outcomes: [string, string, string | undefined, boolean][] = [];
    const expected: typeof outcomes = [];
    for (const [caller, act, isAdmin] of callers) {
      for (const [road, kind, take] of roads) {
        runAs(0);
        const invite = await mint();
        act();
        let refusal: string | undefined;
        try {
          await take(invite);
        } catch (error) {
          refusal = (error as Error).name;
        }
        const kept = await getDbAsSystem().get(tables.AccessInvite, { id: invite.id });
        outcomes.push([caller, road, refusal, kept?.accessLevel === 'read' && kept?.token === invite.token]);
        expected.push([caller, road, isAdmin && kind === 'reads' ? undefined : 'TableAuthError', true]);
      }
    }
    expect(outcomes).toEqual(expected);

    // The mint's own check stands: a person who holds nothing on the resource mints nothing.
    runAs(1);
    await expect(mint()).rejects.toThrow();

    // The table service's gate, asked before anything is run: a signed-in person is told no for every method,
    // by the table's name; the admin's reads are admitted and the admin's writes are told no the same way.
    const gate = new TableServiceAuth();
    const row = { id: 'any', accessLevel: 'write' };
    const methods: [string, 'reads' | 'writes', unknown[]][] = [
      ['query', 'reads', [tables.AccessInvite, {}]],
      ['get', 'reads', [tables.AccessInvite, { id: 'any' }]],
      ['getRowCount', 'reads', [tables.AccessInvite]],
      ['insert', 'writes', [tables.AccessInvite, row]],
      ['update', 'writes', [tables.AccessInvite, row]],
      ['updatePreserving', 'writes', [tables.AccessInvite, row, []]],
      [
        'updateArrayMembership',
        'writes',
        [tables.AccessInvite, { recordId: 'any', columnPropertyName: 'acceptedBy', ops: [] }],
      ],
      ['delete', 'writes', [tables.AccessInvite, { id: 'any' }]],
    ];
    const told: [string, string, string][] = [];
    const due: typeof told = [];
    for (const [who, act, isAdmin] of [
      ['a person', () => runAs(1), false],
      ['the break-glass admin', asAdmin, true],
    ] as const) {
      act();
      for (const [method, kind, args] of methods) {
        let answer: string;
        try {
          answer = gate.canAccess(method, args as any[]) ? 'admitted' : 'not admitted';
        } catch (error) {
          const refusal = error as Error;
          answer = `${refusal.name}, naming the table: ${refusal.message.includes(tables.AccessInvite.name)}`;
        }
        told.push([who, method, answer]);
        due.push([who, method, isAdmin && kind === 'reads' ? 'admitted' : 'ServiceError, naming the table: true']);
      }
    }
    expect(told).toEqual(due);
  });

  // ————————————————————————————————— A ROW'S MOVE —————————————————————————————————

  /** The permission source a row is in, as the system reads it. */
  const sourceOf = async (id: string) =>
    (await getSharedDbAsSystem().get(sharedItemTable, { id }))?.permissionSource?._id;

  const grant = async (userIndex: number, resourceId: string, accessLevel: AccessGrant['accessLevel']) =>
    await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference('user', users[userIndex].id),
      resource: new Reference(sharedItemTable.name, resourceId),
      resourceTable: sharedItemTable.name,
      accessLevel,
    });

  it('a row is moved into another permission source only by a caller who holds write on that source: holding nothing on it, or read, the move is refused by name on every update road and the row stays where it is; a row keeps a source', async () => {
    runAs(0);
    const theirs = await getSharedDb().insert(sharedItemTable, { name: 'user0 doc' });
    const into = new Reference<SharedItem>(sharedItemTable.name, theirs.id);
    // A write grant the caller holds under the same id in ANOTHER table's name: the source asked about is the one
    // this table's rows take their permission from, whatever table a payload's reference names.
    const elsewhere = 'user_test_other_kind';
    await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference(elsewhere, theirs.id),
      resourceTable: elsewhere,
      accessLevel: 'write',
    });
    runAs(1);
    const roads: [string, (row: SharedItem) => Promise<number>][] = [
      ['an update by id', (row) => getSharedDb().update(sharedItemTable, { id: row.id, permissionSource: into })],
      [
        "an update whose reference names another table's row of the same id",
        (row) =>
          getSharedDb().update(sharedItemTable, {
            id: row.id,
            permissionSource: new Reference<SharedItem>(elsewhere, theirs.id),
          }),
      ],
      [
        'an update by a query',
        (row) => getSharedDb().update(sharedItemTable, { permissionSource: into }, { name: row.name }),
      ],
      [
        'a preserving update',
        (row) =>
          getSharedDb().updatePreserving(
            sharedItemTable,
            { id: row.id, meta: { a: 2 }, permissionSource: into } as Partial<SharedItem>,
            [{ columnPropertyName: 'meta', paths: ['a'] }]
          ),
      ],
      [
        'an update whose reference has no id',
        (row) =>
          getSharedDb().update(sharedItemTable, {
            id: row.id,
            permissionSource: new Reference<SharedItem>(sharedItemTable.name, undefined as unknown as string),
          }),
      ],
      [
        'an update whose source is a plain object that names the id',
        (row) =>
          getSharedDb().update(sharedItemTable, {
            id: row.id,
            permissionSource: { _table: sharedItemTable.name, _id: theirs.id } as unknown as Reference<SharedItem>,
          }),
      ],
      [
        'an update whose reference id is a list',
        (row) =>
          getSharedDb().update(sharedItemTable, {
            id: row.id,
            permissionSource: new Reference<SharedItem>(sharedItemTable.name, [row.id, theirs.id] as unknown as string),
          }),
      ],
      [
        'an update whose reference id is an object',
        (row) =>
          getSharedDb().update(sharedItemTable, {
            id: row.id,
            permissionSource: new Reference<SharedItem>(sharedItemTable.name, { id: theirs.id } as unknown as string),
          }),
      ],
      [
        'an update that clears the source',
        (row) =>
          getSharedDb().update(sharedItemTable, {
            id: row.id,
            permissionSource: null,
          } as unknown as Partial<SharedItem>),
      ],
    ];

    // Every road, with nothing held on the other source and then with read: what the caller is told, and where
    // the row is afterwards as the system reads it. One row a try, so each road answers for itself.
    const outcomes: [string, string, string | undefined, boolean][] = [];
    for (const held of ['nothing', 'read'] as const) {
      if (held === 'read') {
        await grant(1, theirs.id, 'read');
      }
      for (const [road, move] of roads) {
        const row = await getSharedDb().insert(sharedItemTable, {
          name: `user1 row, ${held}, ${road}`,
          meta: { a: 1 },
        });
        let refusal: string | undefined;
        try {
          await move(row);
        } catch (error) {
          refusal = (error as Error).name;
        }
        outcomes.push([held, road, refusal, (await sourceOf(row.id)) === row.id]);
      }
    }
    const refusedAndStayed: typeof outcomes = [];
    for (const held of ['nothing', 'read']) {
      for (const [road] of roads) {
        refusedAndStayed.push([held, road, 'RecordAccessError', true]);
      }
    }
    expect(outcomes).toEqual(refusedAndStayed);
    // The other source holds its own row alone.
    const inTheirs = await getSharedDbAsSystem().query(sharedItemTable, { permissionSource: theirs.id } as any);
    expect(inTheirs.map((row) => row.id)).toEqual([theirs.id]);
  });

  it('a writer of the new source moves a row of theirs into it, where the people that source reaches read it; an update that names the source a row is already in is written for any writer of it; a move made as the system is not asked', async () => {
    runAs(0);
    const theirs = await getSharedDb().insert(sharedItemTable, { name: 'user0 doc' });
    await grant(1, theirs.id, 'write');
    const into = new Reference<SharedItem>(sharedItemTable.name, theirs.id);
    runAs(1);
    const row = await getSharedDb().insert(sharedItemTable, { name: 'user1 row' });

    await getSharedDb().update(sharedItemTable, { id: row.id, permissionSource: into });
    expect(await sourceOf(row.id)).toBe(theirs.id);
    // In its new source the row is read by that source's people: its owner reads it.
    runAs(0);
    expect((await getSharedDb().get(sharedItemTable, { id: row.id }))?.name).toBe('user1 row');

    // A writer who is not the owner saves the whole row, the source it is already in included: written.
    runAs(1);
    await getSharedDb().update(sharedItemTable, { id: row.id, name: 'edited where it is', permissionSource: into });
    expect((await getSharedDbAsSystem().get(sharedItemTable, { id: row.id }))?.name).toBe('edited where it is');

    // The system re-homes a row whoever the session is: user2 holds nothing on either source.
    runAs(2);
    await getSharedDbAsSystem().update(sharedItemTable, {
      id: row.id,
      permissionSource: new Reference<SharedItem>(sharedItemTable.name, row.id),
    });
    expect(await sourceOf(row.id)).toBe(row.id);

    // With the grants switched off for a run (`setSkipAccessGrants`), a move is asked nothing, as an insert is.
    setSkipAccessGrants(true);
    try {
      await getSharedDb().update(sharedItemTable, { id: row.id, permissionSource: into });
      expect(await sourceOf(row.id)).toBe(theirs.id);
    } finally {
      setSkipAccessGrants(false);
    }
  });

  it("the source asked about is the one the table's rows take their permission from, and a row that is not a root holds no grant of its own: a row of a table whose rows hang on another table's moves between two of those its mover may write and into no other; a row that was never a root is not made its own source, and in a table whose rows hang on another table's a row that shares its source's id is its writer's to move", async () => {
    runAs(0);
    const theirs = await getSharedDb().insert(sharedItemTable, { name: 'user0 doc' });
    runAs(1);
    const first = await getSharedDb().insert(sharedItemTable, { name: 'user1 first doc' });
    const second = await getSharedDb().insert(sharedItemTable, { name: 'user1 second doc' });
    const inItem = (item: SharedItem) => new Reference<SharedItem>(sharedItemTable.name, item.id);
    const note = await getSharedDb().insert(sharedNoteTable, {
      text: 'a note',
      permissionSource: inItem(first),
    } as Partial<SharedNote> as SharedNote);
    const noteSource = async () => (await getDbAsSystem().get(sharedNoteTable, { id: note.id }))?.permissionSource?._id;
    expect(await noteSource()).toBe(first.id);

    // Between two items its mover may write: written. The grant asked about is on the item, under the items' table.
    await getSharedDb().update(sharedNoteTable, { id: note.id, permissionSource: inItem(second) });
    expect(await noteSource()).toBe(second.id);

    // Into an item its mover holds nothing on: refused by name, and the note stays.
    const refusalOf = async (update: () => Promise<number>) => {
      try {
        await update();
      } catch (error) {
        return (error as Error).name;
      }
      return undefined;
    };
    expect(
      await refusalOf(() => getSharedDb().update(sharedNoteTable, { id: note.id, permissionSource: inItem(theirs) }))
    ).toBe('RecordAccessError');
    expect(await noteSource()).toBe(second.id);

    // A row that was never a root is not made its own source: a grant is born with a root, and this row is none.
    const line = await getSharedDb().insert(sharedItemTable, {
      name: 'a line of user1 first doc',
      permissionSource: inItem(first),
      permissionSourceTable: sharedItemTable.name,
    } as Partial<SharedItem> as SharedItem);
    expect(
      await refusalOf(() =>
        getSharedDb().update(sharedItemTable, {
          id: line.id,
          permissionSource: new Reference<SharedItem>(sharedItemTable.name, line.id),
        })
      )
    ).toBe('RecordAccessError');
    expect(await sourceOf(line.id)).toBe(first.id);

    // In a table whose rows take their permission from another table's, no row is its own source: a note that
    // shares the id of the item it is in is its writer's to move, though they hold neither admin nor owner on
    // that item.
    await grant(1, theirs.id, 'write');
    const twin = await getSharedDb().insert(sharedNoteTable, {
      id: theirs.id,
      text: 'a note with the id of the item it is in',
      permissionSource: inItem(theirs),
    } as Partial<SharedNote> as SharedNote);
    // A miss of its own is answered with no row and no refusal; and here too a person names the row by its id.
    expect(
      await getSharedDb().update(
        sharedNoteTable,
        { permissionSource: inItem(first) },
        { id: twin.id, text: 'no such text' }
      )
    ).toBe(0);
    expect(
      await refusalOf(() =>
        getSharedDb().update(sharedNoteTable, { permissionSource: inItem(first) }, { text: 'a note' })
      )
    ).toBe('RecordAccessError');
    expect(await getSharedDb().update(sharedNoteTable, { id: twin.id, permissionSource: inItem(first) })).toBe(1);
    expect((await getDbAsSystem().get(sharedNoteTable, { id: twin.id }))?.permissionSource?._id).toBe(first.id);
  });

  it("a row that is its own permission source is given another by a caller who holds admin or owner on it: a caller who may write it and no more is refused by name when they name it by its id, alone, in a preserving update and inside a transaction, and the row keeps its source and its people; a person names the row by its id, and an update that names rows by a query is refused; a row that takes its permission from it is a writer's to move, and a save that names the row itself is written; a caller who holds admin on it, its owner and the system move it; with the grants switched off a move is asked nothing", async () => {
    runAs(0);
    const theirs = await getSharedDb().insert(sharedItemTable, { name: 'user0 doc', meta: { a: 1 } });
    const itself = new Reference<SharedItem>(sharedItemTable.name, theirs.id);
    const line = await getSharedDb().insert(sharedItemTable, {
      name: 'a line of user0 doc',
      permissionSource: itself,
    } as any);
    await grant(1, theirs.id, 'write');
    // Owner on the same id under ANOTHER table's name gives nothing on this table's row.
    await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference('user', users[1].id),
      resource: new Reference('user_test_other_kind', theirs.id),
      resourceTable: 'user_test_other_kind',
      accessLevel: 'owner',
    });
    runAs(1);
    const mine = await getSharedDb().insert(sharedItemTable, { name: 'user1 doc' });
    const underMine = new Reference<SharedItem>(sharedItemTable.name, mine.id);
    const theseRows = (ids: string[]) =>
      new QueryBuilderFactory().getQueryBuilder(sharedItemTable).condition({ field: 'id', operator: 'IN', value: ids });
    const told = async (move: () => Promise<number>) => {
      try {
        return `answered ${await move()}`;
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }
    };
    const stayed = async () => [(await sourceOf(theirs.id)) === theirs.id, (await sourceOf(line.id)) === theirs.id];

    // A caller who may write the row and no more names it by its id: refused by name, on each road that does.
    const byItsId: [string, () => Promise<number>][] = [
      ['an update by id', () => getSharedDb().update(sharedItemTable, { id: theirs.id, permissionSource: underMine })],
      [
        'an update by a query that holds the id',
        () => getSharedDb().update(sharedItemTable, { permissionSource: underMine }, { id: theirs.id }),
      ],
      [
        'a preserving update',
        () =>
          getSharedDb().updatePreserving(
            sharedItemTable,
            { id: theirs.id, meta: { a: 2 }, permissionSource: underMine } as Partial<SharedItem>,
            [{ columnPropertyName: 'meta', paths: ['a'] }]
          ),
      ],
      [
        'an update inside a transaction of the caller',
        () =>
          getDb().runTransaction(async () =>
            getSharedDb().update(sharedItemTable, { id: theirs.id, permissionSource: underMine })
          ),
      ],
    ];
    const byName = `RecordAccessError: User holds neither admin nor owner on ${sharedItemTable.name}:${theirs.id}:`;
    for (const [road, move] of byItsId) {
      expect([road, await told(move), await stayed()]).toEqual([road, expect.stringContaining(byName), [true, true]]);
    }

    // A person's update that names a permission source names its row by its id: rows named by a query are not moved.
    const byAQuery: [string, () => Promise<number>][] = [
      [
        'an update by a query that holds no id',
        () => getSharedDb().update(sharedItemTable, { permissionSource: underMine }, { name: 'user0 doc' }),
      ],
      [
        'an update by a builder',
        () => getSharedDb().update(sharedItemTable, { permissionSource: underMine }, theseRows([theirs.id])),
      ],
      [
        'an update of several rows, the row among them',
        () => getSharedDb().update(sharedItemTable, { permissionSource: underMine }, theseRows([line.id, theirs.id])),
      ],
    ];
    const byItsIdAlone = `RecordAccessError: A ${sharedItemTable.name} row is given a permission source by its id:`;
    for (const [road, move] of byAQuery) {
      expect([road, await told(move), await stayed()]).toEqual([
        road,
        expect.stringContaining(byItsIdAlone),
        [true, true],
      ]);
    }
    // An update that matches nothing for a reason of its own is answered with no row and no refusal: when it names
    // no source, when it names the row itself, and when the row takes its permission from another row.
    const noSuchName = { name: 'no such name' };
    expect(
      await told(() => getSharedDb().update(sharedItemTable, { name: 'x' }, { id: theirs.id, ...noSuchName }))
    ).toBe('answered 0');
    expect(
      await told(() =>
        getSharedDb().update(sharedItemTable, { permissionSource: itself }, { id: theirs.id, ...noSuchName })
      )
    ).toBe('answered 0');
    expect(
      await told(() =>
        getSharedDb().update(sharedItemTable, { permissionSource: underMine }, { id: line.id, ...noSuchName })
      )
    ).toBe('answered 0');
    // The step is run with the rows of its update: handed none, it says what it needs. Handed them, it adds its
    // rule to the update's own conditions, and names the row there itself.
    const step = (sharedItemTable.columns as any).permissionSource.options.onBeforeUpdate;
    await expect(step(sharedItemTable, { permissionSource: underMine }, false)).rejects.toThrow(/UpdateRows/);
    const conditions = new QueryBuilderFactory().getQueryBuilder(sharedItemTable);
    await step(sharedItemTable, { permissionSource: underMine }, false, { id: theirs.id, conditions });
    const parts = (conditions.graph.nodes() as string[]).map((nodeId) => conditions.graph.node(nodeId));
    expect(parts.filter((part) => part.type === 'CONDITION' && part.field === 'id').map((part) => part.value)).toEqual([
      theirs.id,
    ]);
    expect(parts.filter((part) => part.type === 'LOGICAL').map((part) => part.operator)).toEqual(['OR']);
    // Its people reach it as they did: its owner saves it.
    runAs(0);
    expect(await getSharedDb().update(sharedItemTable, { id: theirs.id, name: 'user0 doc, renamed' })).toBe(1);

    // A row that takes its permission from it is a writer's to move; a writer's save of the whole row, the row
    // itself named as its source, is written.
    runAs(1);
    expect(await getSharedDb().update(sharedItemTable, { id: line.id, permissionSource: underMine })).toBe(1);
    expect(await sourceOf(line.id)).toBe(mine.id);
    expect(
      await getSharedDb().update(sharedItemTable, {
        id: theirs.id,
        name: 'edited where it is',
        permissionSource: itself,
      })
    ).toBe(1);
    expect(await sourceOf(theirs.id)).toBe(theirs.id);

    // A caller who holds admin on it moves it (they hold write on the new source, as every mover does).
    await grant(2, theirs.id, 'admin');
    await grant(2, mine.id, 'write');
    runAs(2);
    // An update of theirs that matches nothing for a reason of its own is answered with no row and no refusal.
    expect(
      await told(() =>
        getSharedDb().update(sharedItemTable, { permissionSource: underMine }, { id: theirs.id, ...noSuchName })
      )
    ).toBe('answered 0');
    expect(await getSharedDb().update(sharedItemTable, { id: theirs.id, permissionSource: underMine })).toBe(1);
    expect(await sourceOf(theirs.id)).toBe(mine.id);
    // The system moves it, whoever the session is and however it names the row: the session's person may write
    // it and no more.
    runAs(1);
    expect(await getSharedDbAsSystem().update(sharedItemTable, { id: theirs.id, permissionSource: itself })).toBe(1);
    expect(
      await getSharedDbAsSystem().update(sharedItemTable, { permissionSource: underMine }, theseRows([theirs.id]))
    ).toBe(1);
    expect(await sourceOf(theirs.id)).toBe(mine.id);
    await getSharedDbAsSystem().update(sharedItemTable, { id: theirs.id, permissionSource: itself });
    // Its owner moves it.
    await grant(0, mine.id, 'write');
    runAs(0);
    expect(await getSharedDb().update(sharedItemTable, { id: theirs.id, permissionSource: underMine })).toBe(1);
    expect(await sourceOf(theirs.id)).toBe(mine.id);

    // With the grants switched off for a run, a move is asked nothing.
    await getSharedDbAsSystem().update(sharedItemTable, { id: theirs.id, permissionSource: itself });
    runAs(1);
    setSkipAccessGrants(true);
    try {
      expect(await getSharedDb().update(sharedItemTable, { permissionSource: underMine }, theseRows([theirs.id]))).toBe(
        1
      );
      expect(await sourceOf(theirs.id)).toBe(mine.id);
    } finally {
      setSkipAccessGrants(false);
    }
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
