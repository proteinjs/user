jest.mock('../src/UserRepo', () => {
  return {
    UserRepo: jest.fn().mockImplementation(() => {
      return {
        getUser: jest.fn().mockReturnValue({ id: 'user0' }),
      };
    }),
  };
});

import { Db, Reference, ReferenceColumn, StringColumn, Table } from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { ScopedRecord, withScopedRecordColumns } from '../src/ScopedRecord';

export interface Favorite extends ScopedRecord {
  name: string;
  parent?: Reference<Favorite>;
}

const users: { name: string; id: string; email: string }[] = [
  { name: 'user0', id: 'user0', email: 'user0@null.local' },
  { name: 'user1', id: 'user1', email: 'user1@null.local' },
];

export class FavoriteTable extends Table<Favorite> {
  name = 'user_test_user';
  columns = withScopedRecordColumns<Favorite>(
    {
      name: new StringColumn('name'),
      parent: new ReferenceColumn('parent', this.name, false, { nullable: true }),
    },
    {
      useDefaultScope: false,
      inheritScope: {
        parentColumn: 'parent',
      },
    }
  );
}

const getTable = (tableName: string) => {
  const userTable = new FavoriteTable();
  if (userTable.name == tableName) {
    return userTable;
  }

  throw new Error('Cannot find test table');
};

const dbDriver = new KnexDriver(
  {
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  },
  getTable
);

const dropTable = async (table: Table<any>) => {
  if (await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).hasTable(table.name)) {
    await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).dropTable(table.name);
  }
};

const db = new Db(dbDriver, getTable);

describe('Scoped Record', () => {
  beforeAll(async () => {
    if (dbDriver.start) {
      await dbDriver.start();
    }
  });

  beforeEach(async () => {
    await dbDriver.getTableManager().loadTable(new FavoriteTable());
  });

  afterEach(async () => {
    await dropTable(new FavoriteTable());
  });

  afterAll(() => {
    if (dbDriver.stop) {
      dbDriver.stop();
    }
  });

  test('Query scoped records', async () => {
    const favoriteTable: Table<Favorite> = new FavoriteTable();

    const [user0, user1] = users;
    await db.insert(favoriteTable, { name: `${user0.name}_favorite1`, scope: user0.id });
    await db.insert(favoriteTable, { name: `${user0.name}_favorite2`, scope: user0.id });
    await db.insert(favoriteTable, { name: `${user0.name}_favorite3`, scope: user0.id });
    await db.insert(favoriteTable, { name: `${user1.name}_favorite1`, scope: user1.id });
    await db.insert(favoriteTable, { name: `${user1.name}_favorite2`, scope: user1.id });
    const favorites = await db.query(favoriteTable, {});
    expect(favorites.length).toBe(3);
  });

  test('Query records with inherited scope', async () => {
    const favoriteTable: Table<Favorite> = new FavoriteTable();
    const [user0, user1] = users;

    const parent = await db.insert(favoriteTable, {
      name: 'Parent Favorite',
      scope: user0.id,
    });

    const child = await db.insert(favoriteTable, {
      name: 'Child Favorite',
      scope: user1.id,
      parent: Reference.fromObject(FavoriteTable.name, parent),
    });

    const other = await db.insert(favoriteTable, {
      name: 'Unrelated Favorite',
      scope: user1.id,
    });

    const favorites = await db.query(favoriteTable, {});

    // should return the parent record (direct scope match)
    // and the child record (inherited scope through parent)
    expect(favorites.length).toBe(2);

    const resultNames = favorites.map((r) => r.name);
    expect(resultNames).toContain(parent.name);
    expect(resultNames).toContain(child.name);
    expect(resultNames).not.toContain(other.name);
  });
});
