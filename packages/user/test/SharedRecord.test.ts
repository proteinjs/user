import { UserRepo } from '../src/UserRepo';

import moment from 'moment';
import { Db, DbDriver, getDb, Reference, StringColumn, Table } from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { getSharedDb, getSharedDbAsSystem, SharedRecord, withSharedRecordColumns } from '../src/SharedRecord';
import { AccessGrantTable } from '../src/tables/AccessGrantTable';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '../src/tables/tables';

export interface SharedItem extends SharedRecord {
  name: string;
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

const users = [
  {
    name: 'Test user0',
    email: 'test.user0',
    password: 'test',
    emailVerified: false,
    roles: '',
    created: moment(),
    updated: moment(),
    id: 'user0',
  },
  {
    name: 'Test user1',
    email: 'test.user1',
    password: 'test',
    emailVerified: false,
    roles: '',
    created: moment(),
    updated: moment(),
    id: 'user1',
  },
];

export class SharedItemTable extends Table<SharedItem> {
  name = 'user_test_shared_item';
  columns = withSharedRecordColumns<SharedItem>({
    name: new StringColumn('name'),
  });
}

const dbDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});
const userRepo = new UserRepo();

const dropTable = async (table: Table<any>) => {
  if (await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).hasTable(table.name)) {
    await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).dropTable(table.name);
  }
};

// TODO use TestEnvironment
describe('Shared Record', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      new DbDriverFactory(dbDriver),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [
      tables.AccessGrant,
      new SharedItemTable() as Table<SharedItem>,
    ];

    Session.setData({
      sessionId: 'test-session',
      user: 'guest',
      data: {},
    });

    userRepo.setUser(users[0]);

    if (dbDriver.start) {
      await dbDriver.start();
    }

    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => dbDriver);
  });

  beforeEach(async () => {
    await dbDriver.getTableManager().loadTable(new SharedItemTable());
    await dbDriver.getTableManager().loadTable(new AccessGrantTable());
  });

  afterEach(async () => {
    await dropTable(new SharedItemTable());
    await dropTable(new AccessGrantTable());
  });

  afterAll(() => {
    if (dbDriver.stop) {
      dbDriver.stop();
    }
  });

  test('Query shared records with access grants', async () => {
    const sharedItemTable = new SharedItemTable() as Table<SharedItem>;
    const [user0, user1] = users;

    // create user0 items w/ default AccessGrants
    const user0Item1 = await getSharedDbAsSystem().insert(sharedItemTable, {
      name: `${user0.name}_item1`,
    });

    const user0Item2 = await getSharedDbAsSystem().insert(sharedItemTable, {
      name: `${user0.name}_item2`,
    });

    userRepo.setUser(user1);
    const user1Item1 = await getSharedDbAsSystem().insert(sharedItemTable, {
      name: `${user1.name}_item1`,
    });
    userRepo.setUser(user0);

    const items = await getSharedDb().query(sharedItemTable, {});

    // Should only return items that user0 has access to
    expect(items.length).toBe(2);

    const itemNames = items.map((item) => item.name);
    expect(itemNames).toContain(user0Item1.name);
    expect(itemNames).toContain(user0Item2.name);
    expect(itemNames).not.toContain(user1Item1.name);
  });

  test('System DB can access all shared records', async () => {
    const sharedItemTable = new SharedItemTable();
    const [user0, user1] = users;

    userRepo.setUser(user0);
    await getSharedDb().insert(sharedItemTable, {
      name: `${user0.name}_item1`,
    });

    userRepo.setUser(user1);
    await getSharedDb().insert(sharedItemTable, {
      name: `${user1.name}_item1`,
    });

    const items = await getSharedDbAsSystem().query(sharedItemTable, {});

    expect(items.length).toBe(2);
  });

  test('Only Admin can create AccessGrants', async () => {
    const sharedItemTable = new SharedItemTable();
    const accessGrantTable = new AccessGrantTable();
    const [user0, user1] = users;

    userRepo.setUser(user0);
    const sharedItem = await getSharedDbAsSystem().insert(sharedItemTable, {
      name: 'Shared item for access grant test',
    });

    try {
      userRepo.setUser(user1);
      await getDb().insert(accessGrantTable, {
        principal: new Reference('user', user1.id),
        resource: new Reference(sharedItemTable.name, sharedItem.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'read',
      });

      // If we reach here, the test should fail because the insert should have thrown an error
      fail('User without admin access was able to create an access grant');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }

    userRepo.setUser(user0);
    const grantForUser1 = await getDb().insert(accessGrantTable, {
      principal: new Reference('user', user1.id),
      resource: new Reference(sharedItemTable.name, sharedItem.id),
      resourceTable: sharedItemTable.name,
      accessLevel: 'read',
    });

    expect(grantForUser1.id).toBeDefined();
    expect(grantForUser1.principal._id).toBe(user1.id);
    expect(grantForUser1.accessLevel).toBe('read');
  });
});
