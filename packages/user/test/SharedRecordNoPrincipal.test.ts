import moment from 'moment';
import { Db, DbDriver, Reference, StringColumn, Table } from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { SourceRepository } from '@proteinjs/reflection';
import { NoPrincipalError } from '../src/NoPrincipalError';
import {
  getSharedDb,
  getSharedDbAsSystem,
  setSkipAccessGrants,
  SharedRecord,
  withSharedRecordColumns,
} from '../src/SharedRecord';
import { AccessGrantTable } from '../src/tables/AccessGrantTable';
import { tables } from '../src/tables/tables';
import { User } from '../src/tables/UserTable';
import { UserRepo } from '../src/UserRepo';

/**
 * A grant-scoped operation on a shared table with NO principal — access grants enforced, no session
 * user in the context (a background executor, a boot- or deploy-time migration, a socket event
 * callback) — refuses AT THE SOURCE with `NoPrincipalError`: the table, the operation and the first
 * stack frame outside the libraries on one line, instead of the query builder's opaque `Must not pass
 * in undefined for value in condition … principal`. With a session user, or with grants skipped, the
 * operation is unchanged: the rows come back.
 */
export interface NoPrincipalItem extends SharedRecord {
  name: string;
}

export class NoPrincipalItemTable extends Table<NoPrincipalItem> {
  name = 'user_test_no_principal_item';
  // Public doors: the subject under test is the shared-record principal requirement, not the door.
  auth: Table<NoPrincipalItem>['auth'] = {
    db: { all: 'public' },
    service: { all: 'public' },
  };
  columns = withSharedRecordColumns<NoPrincipalItem>({
    name: new StringColumn('name'),
  });
}

class DbDriverFactory {
  constructor(private dbDriver: DbDriver) {}

  getDbDriver() {
    return this.dbDriver;
  }
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

const owner: User = {
  name: 'Owner',
  email: 'owner',
  password: 'test',
  emailVerified: false,
  roles: [],
  created: moment(),
  updated: moment(),
  id: 'owner',
};

const dbDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});
const userRepo = new UserRepo();
const itemTable = new NoPrincipalItemTable();

const dropTable = async (table: Table<any>) => {
  if (await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).hasTable(table.name)) {
    await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).dropTable(table.name);
  }
};

const noSessionUser = () => userRepo.setUser(undefined as unknown as User);

/** The NoPrincipalError `operation` rejects with — the rows, if it resolved, are the failure. */
async function thrownBy(operation: Promise<unknown>): Promise<NoPrincipalError> {
  let result: unknown;
  try {
    result = await operation;
  } catch (error) {
    if (error instanceof NoPrincipalError) {
      return error;
    }
    throw new Error(`expected NoPrincipalError, got ${(error as Error).constructor.name}: ${(error as Error).message}`);
  }
  throw new Error(`expected NoPrincipalError, the operation resolved with ${JSON.stringify(result)}`);
}

describe('SharedRecord — a grant-scoped operation with no principal refuses by name', () => {
  let getDefaultDbDriver: jest.SpyInstance;

  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      new DbDriverFactory(dbDriver),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [
      tables.AccessGrant,
      itemTable as Table<NoPrincipalItem>,
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [userRepo];
    Session.setData({ sessionId: 'test-session', user: 'guest', data: {} });
    if (dbDriver.start) {
      await dbDriver.start();
    }
    getDefaultDbDriver = jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => dbDriver);
  });

  beforeEach(async () => {
    setSkipAccessGrants(false);
    await dbDriver.getTableManager().loadTable(itemTable);
    await dbDriver.getTableManager().loadTable(tables.AccessGrant);
  });

  afterEach(async () => {
    await dropTable(itemTable);
    await dropTable(new AccessGrantTable());
  });

  afterAll(async () => {
    setSkipAccessGrants(false);
    getDefaultDbDriver.mockRestore();
    if (dbDriver.stop) {
      await dbDriver.stop();
    }
  });

  /** A scope root the owner created with grants enforced — its owner grant conferred by the insert. */
  async function ownersItem(): Promise<NoPrincipalItem> {
    userRepo.setUser(owner);
    return await getSharedDb().insert(itemTable, { name: 'the owner’s item' });
  }

  it('with grants enforced and no session user, a read throws NoPrincipalError naming the table, the operation and this file', async () => {
    await ownersItem();
    noSessionUser();

    const error = await thrownBy(getSharedDb().query(itemTable, {}));

    expect({ table: error.table, operation: error.operation }).toEqual({ table: itemTable.name, operation: 'read' });
    expect(error.frame).toContain('SharedRecordNoPrincipal.test.ts');
    expect(error.message.split('\n')).toHaveLength(1);
    expect(error.message).toBe(
      `${itemTable.name}: a read that needs a principal ran with none ` +
        `(no session user in this async context, access grants enforced) — at ${error.frame}`
    );
  });

  it('with grants enforced and no session user, a write and an attaching insert refuse the same way, naming their operations', async () => {
    const item = await ownersItem();
    noSessionUser();

    const write = await thrownBy(getSharedDb().update(itemTable, { id: item.id, name: 'renamed with no principal' }));
    expect({ table: write.table, operation: write.operation }).toEqual({ table: itemTable.name, operation: 'write' });

    const attach = await thrownBy(
      getSharedDb().insert(itemTable, {
        name: 'attached with no principal',
        permissionSource: new Reference(itemTable.name, item.id),
      } as Omit<NoPrincipalItem, keyof SharedRecord>)
    );
    expect({ table: attach.table, operation: attach.operation }).toEqual({
      table: itemTable.name,
      operation: 'insert',
    });

    expect((await getSharedDbAsSystem().query(itemTable, {})).map((row) => row.name)).toEqual(['the owner’s item']);
  });

  it('with a session user the rows come back — unchanged', async () => {
    const item = await ownersItem();

    const rows = await getSharedDb().query(itemTable, {});

    expect(rows.map((row) => row.id)).toEqual([item.id]);
  });

  it('with grants skipped and no session user the rows come back — unchanged', async () => {
    const item = await ownersItem();
    noSessionUser();
    setSkipAccessGrants(true);

    const rows = await getSharedDb().query(itemTable, {});

    expect(rows.map((row) => row.id)).toEqual([item.id]);
  });
});
