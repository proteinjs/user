import { UserRepo } from '../src/UserRepo';

import moment from 'moment';
import { Db, QueryBuilderFactory, Reference, StringColumn, Table, Transaction, getDbAsSystem } from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { SharedRecord, withSharedRecordColumns } from '../src/SharedRecord';
import { AccessGrant, AccessGrantTable } from '../src/tables/AccessGrantTable';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '../src/tables/tables';

/**
 * Browser-path root creation (the 2026-08-22 release blocker). A NEW root shared record created
 * from the BROWSER rides the client `Transaction` queue, and `Transaction.insert` applies column
 * defaults CLIENT-SIDE — in an environment with no `DefaultDbDriverFactory` (the browser has no
 * driver; `new Db()` throws). The escalation fix moved the owner-grant bootstrap into the
 * `permissionSource` defaultValue as a `getDbAsSystem()` insert, which made the default IMPURE and
 * broke every browser root creation with "Unable to find a @proteinjs/db/DefaultDbDriverFactory
 * implementation".
 *
 * The floor pinned here: the column default is PURE (client-side default application needs no db),
 * and the owner-grant bootstrap runs SERVER-SIDE on the insert path — so the whole client flow
 * (queue with defaults in a driverless context, then run the ops server-side) succeeds AND ends
 * with exactly one platform-conferred owner grant.
 *
 * Outcome bar: assertions are against persisted rows and grant state read back as system.
 */

export interface ClientRootItem extends SharedRecord {
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

const users = [0, 1].map((i) => ({
  name: `Test user${i}`,
  email: `test.user${i}`,
  password: 'test',
  emailVerified: false,
  roles: [] as string[],
  created: moment(),
  updated: moment(),
  id: `user${i}`,
}));

export class ClientRootItemTable extends Table<ClientRootItem> {
  name = 'user_test_client_root_item';
  auth: Table<ClientRootItem>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<ClientRootItem>({
    name: new StringColumn('name'),
  });
}

const dbDriver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
const userRepo = new UserRepo();
const clientRootItemTable = new ClientRootItemTable() as Table<ClientRootItem>;

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
    .condition({ field: 'resourceTable', operator: '=', value: clientRootItemTable.name });
  return await getDbAsSystem().query(tables.AccessGrant, qb);
};

/**
 * The browser has no `DefaultDbDriverFactory`: any code path that constructs a `Db` during
 * client-side default application dies with this exact error (Db.getDefaultDbDriver). Mock the
 * static resolver to throw it, run `fn`, restore the server driver.
 */
const inDriverlessClientContext = async <T>(fn: () => Promise<T>): Promise<T> => {
  jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => {
    throw new Error(
      `Unable to find a @proteinjs/db/DefaultDbDriverFactory implementation. Either implement DefaultDbDriverFactory or pass in a db driver when instantiating Db.`
    );
  });
  try {
    return await fn();
  } finally {
    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => dbDriver);
  }
};

describe('Client-path root creation owner-grant bootstrap', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      { getDbDriver: () => dbDriver },
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [tables.AccessGrant, clientRootItemTable];
    (SourceRepository.get() as any).objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [userRepo];

    Session.setData({ sessionId: 'test-session', user: 'guest', data: {} });
    runAs(0);

    if (dbDriver.start) {
      await dbDriver.start();
    }

    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => dbDriver);
  });

  beforeEach(async () => {
    await dbDriver.getTableManager().loadTable(clientRootItemTable);
    await dbDriver.getTableManager().loadTable(tables.AccessGrant);
  });

  afterEach(async () => {
    await dropTable(clientRootItemTable);
    await dropTable(new AccessGrantTable());
  });

  afterAll(() => {
    if (dbDriver.stop) {
      dbDriver.stop();
    }
  });

  it('a driverless client Transaction insert succeeds and the owner grant lands server-side, exactly once', async () => {
    runAs(0);

    // CLIENT PHASE — the browser: queue the root insert; Transaction.insert applies column
    // defaults right here, with NO db driver resolvable. The release regression died on this
    // await (the permissionSource default called getDbAsSystem()).
    const transaction = new Transaction();
    const queued = await inDriverlessClientContext(
      async () => await transaction.insert(clientRootItemTable, { name: 'root from browser' } as any)
    );
    expect(queued.id).toBeDefined();

    // No grant may exist yet — the bootstrap is a SERVER-side act; a client-side mint would mean
    // the default is still impure.
    expect(await grantsFor(users[0].id, queued.id)).toHaveLength(0);

    // SERVER PHASE — run the queued ops the way TransactionRunner does (driver restored).
    await transaction.run();

    // OUTCOMES: the row exists, and the creator holds exactly one platform-conferred owner grant.
    const persisted = await getDbAsSystem().get(clientRootItemTable, { id: queued.id });
    expect(persisted?.name).toBe('root from browser');

    const grants = await grantsFor(users[0].id, queued.id);
    expect(grants.map((grant) => grant.accessLevel)).toEqual(['owner']);
  });

  it('PIN — the row-injection guard still refuses a non-root insert into a foreign scope on the client path', async () => {
    runAs(0);
    const victim = await transactionalInsert({ name: 'user0 root' });

    // user1 queues an insert that points its permissionSource at user0's root — the client
    // Transaction path must be refused server-side exactly like the direct path (HOLE 2 pin).
    runAs(1);
    const injectionTx = new Transaction();
    await inDriverlessClientContext(
      async () =>
        await injectionTx.insert(clientRootItemTable, {
          name: 'injected row',
          permissionSource: new Reference(clientRootItemTable.name, victim.id),
        } as any)
    );

    await expect(injectionTx.run()).rejects.toThrow();

    const rowsInVictimScope = await getDbAsSystem().query(clientRootItemTable, {
      permissionSource: victim.id,
    } as any);
    expect(rowsInVictimScope.map((r: any) => r.name)).not.toContain('injected row');

    // And no grant of any kind landed for user1.
    expect(await grantsFor(users[1].id, victim.id)).toHaveLength(0);
  });

  /** Full client flow: queue driverless, run server-side, return the inserted record. */
  const transactionalInsert = async (record: Partial<ClientRootItem>): Promise<ClientRootItem> => {
    const transaction = new Transaction();
    const queued = await inDriverlessClientContext(
      async () => await transaction.insert(clientRootItemTable, record as any)
    );
    await transaction.run();
    return queued as ClientRootItem;
  };
});
