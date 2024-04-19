import { Db, StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db'
import { KnexDriver } from '@proteinjs/db-driver-knex'

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
	columns = withRecordColumns<Favorite>({
		name: new StringColumn('name'),
    scope: new StringColumn('scope', { 
      defaultValue: async (favorite: Favorite) =>  favorite.name.startsWith(veronicaUser.name) ? veronicaScope : kevinScope,
      addToQuery: async (qb) => { 
        qb.condition({ 
          field: 'scope', 
          operator: 'IN', 
          value: [veronicaScope]
        });
      },
    }),
	});
}

const dbDriver = new KnexDriver({
	host: 'localhost',
	user: 'root',
	password: '',
	dbName: 'test',
});
const dropTable = async (table: Table<any>) => {
  if (await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).hasTable(table.name))
		await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).dropTable(table.name);
}
const getTable = (tableName: string) => {
  const userTable = new FavoriteTable();
  if (userTable.name == tableName)
    return userTable;

  throw new Error('Cannot find test table');
};
const db = new Db(dbDriver, getTable);

describe('Scoped Record', () => {
  beforeAll(async () => {
    if (dbDriver.start)
      await dbDriver.start();

    await dbDriver.getTableManager().loadTable(new FavoriteTable());
  })
  
  afterAll(async () => {
    await dropTable(new FavoriteTable());
    
    if (dbDriver.stop)
      await dbDriver.stop();
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
});