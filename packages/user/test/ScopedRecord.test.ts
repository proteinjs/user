import {
  Db,
  StringColumn,
  Table,
  Record,
  ReferenceArray,
  ReferenceArrayColumn,
  withRecordColumns,
} from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { ScopedRecord, withScopedRecordColumns } from '../src/ScopedRecord';

export interface Favorite extends Record {
  name: string;
  scope?: string;
}

const veronicaUser = { name: 'Veronica', email: 'veroni@cake.com' };
const kevinUser = { name: 'Kevin', email: 'kev@tron.com' };
const veronicaScope = 'vvvveronica';
const kevinScope = 'kevinnn';
export class FavoriteTable extends Table<Favorite> {
  name = 'user_test_user';
  // The suite pins scope-column query injection with NO user in context at all; UserAuth is
  // fail-closed, so the table door must not consult it. Public keeps the subject under test
  // (the scope column) the only filter.
  auth: Table<Favorite>['auth'] = {
    db: { all: 'public' },
    service: { all: 'public' },
  };
  columns: Table<Favorite>['columns'] = withRecordColumns<Favorite>({
    name: new StringColumn('name'),
    scope: new StringColumn('scope', {
      defaultValue: async (table: any, favorite: Favorite) =>
        favorite.name.startsWith(veronicaUser.name) ? veronicaScope : kevinScope,
      addToQuery: async (qb) => {
        qb.condition({
          field: 'scope',
          operator: 'IN',
          value: [veronicaScope],
        });
      },
    }),
  });
}

interface Clipping extends ScopedRecord {
  text: string;
}

interface Folder extends ScopedRecord {
  name: string;
  clippings?: ReferenceArray<Clipping> | null;
}

/** A scoped table, declared the way a consumer declares one. */
class ClippingTable extends Table<Clipping> {
  name = 'user_test_scoped_clipping';
  auth: Table<Clipping>['auth'] = {
    db: { all: 'public' },
    service: { all: 'public' },
  };
  columns = withScopedRecordColumns<Clipping>({
    text: new StringColumn('text'),
  });
}

/** A scoped table whose rows name clippings, and take them along when they are deleted. */
class FolderTable extends Table<Folder> {
  name = 'user_test_scoped_folder';
  auth: Table<Folder>['auth'] = {
    db: { all: 'public' },
    service: { all: 'public' },
  };
  columns = withScopedRecordColumns<Folder>({
    name: new StringColumn('name'),
    clippings: new ReferenceArrayColumn<Clipping>('clippings', 'user_test_scoped_clipping', true),
  });
}

const getTable = (tableName: string) => {
  for (const table of [new FavoriteTable(), new ClippingTable(), new FolderTable()]) {
    if (table.name == tableName) {
      return table;
    }
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

    await dbDriver.getTableManager().loadTable(new FavoriteTable());
    await dbDriver.getTableManager().loadTable(new ClippingTable());
    await dbDriver.getTableManager().loadTable(new FolderTable());
  });

  afterAll(async () => {
    await dropTable(new FavoriteTable());
    await dropTable(new FolderTable());
    await dropTable(new ClippingTable());

    if (dbDriver.stop) {
      await dbDriver.stop();
    }
  });

  test('Query scoped records', async () => {
    const favoriteTable: Table<Favorite> = new FavoriteTable();
    await db.insert(favoriteTable, { name: `${veronicaUser.name}_favorite1` });
    await db.insert(favoriteTable, { name: `${veronicaUser.name}_favorite2` });
    await db.insert(favoriteTable, { name: `${veronicaUser.name}_favorite3` });
    await db.insert(favoriteTable, { name: `${kevinUser.name}_favorite1` });
    await db.insert(favoriteTable, { name: `${kevinUser.name}_favorite2` });
    const favorites = await db.query(favoriteTable, {});
    expect(favorites.length).toBe(3);
  });

  test('a delete made as the system takes, with a scoped row, only the rows it names in its own scope', async () => {
    const systemDb = new Db(dbDriver, getTable, undefined, true);
    const clippings: Table<Clipping> = new ClippingTable();
    const folders: Table<Folder> = new FolderTable();
    const own = await systemDb.insert(clippings, { text: 'own', scope: veronicaScope });
    const anothers = await systemDb.insert(clippings, { text: 'of another scope', scope: kevinScope });
    const folder = await systemDb.insert(folders, {
      name: 'a folder',
      scope: veronicaScope,
      clippings: new ReferenceArray<Clipping>(clippings.name, [own.id, anothers.id]),
    });

    await systemDb.delete(folders, { id: folder.id });

    expect(await systemDb.query(folders, {})).toEqual([]);
    expect((await systemDb.query(clippings, {})).map((clipping) => clipping.text)).toEqual(['of another scope']);
  });
});
