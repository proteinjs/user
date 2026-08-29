import { UserRepo } from '../src/UserRepo';

import moment from 'moment';
import { Db, getDb, getDbAsSystem, QueryBuilderFactory, Reference, StringColumn, Table } from '@proteinjs/db';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { getSharedDbAsSystem, SharedRecord, withSharedRecordColumns } from '../src/SharedRecord';
import { AccessGrant, AccessGrantTable, isMalformedAccessGrantError } from '../src/tables/AccessGrantTable';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '../src/tables/tables';

/**
 * AccessGrant well-formedness invariant (the malformed-grant class, 2026-08-23).
 *
 * The test environment held a non-owner `thought` grant whose principal was NULL; it crashed the
 * deploy-gated OrphanContentReferenceSweep. Origin: `ReferenceColumn.serialize` stores NULL for a
 * Reference with no `_id`, and nothing in the AccessGrant schema ever required one — so every
 * grant write path inherited the hole. Two producers are known:
 *  - the SharedRecord owner-grant bootstrap in a context with NO session user (background
 *    executors, deploy-time migrations): `new UserRepo().getUser()` is `{}` there, so the mint
 *    wrote `principal = Reference('user', undefined)` → NULL;
 *  - any RPC-reachable insert that forwards a caller-supplied id unchecked (ThoughtSharing's
 *    re-level, a direct DbService insert by a resource admin).
 *
 * The invariant lives on the table (one owner): an AccessGrant insert without a principal id or a
 * resource id is refused with a typed error, for system and caller context alike. The bootstrap
 * then names its own no-session case explicitly instead of minting a row for nobody.
 *
 * Outcome bar: assertions read grant rows back as system — never a call merely "succeeding".
 */

interface SharedItem extends SharedRecord {
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

class SharedItemTable extends Table<SharedItem> {
  name = 'user_test_wellformed_shared_item';
  auth: Table<SharedItem>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  columns = withSharedRecordColumns<SharedItem>({
    name: new StringColumn('name'),
  });
}

const dbDriver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
const userRepo = new UserRepo();
const sharedItemTable = new SharedItemTable() as Table<SharedItem>;

const dropTable = async (table: Table<any>) => {
  if (await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).hasTable(table.name)) {
    await dbDriver.getKnex().schema.withSchema(dbDriver.getDbName()).dropTable(table.name);
  }
};

const runAs = (userIndex: number) => {
  Session.setData({ sessionId: 'test-session', user: users[userIndex].email, data: {} });
  userRepo.setUser(users[userIndex]);
};

/** A context with no session user at all — what background executors and boot-time migrations see. */
const runSessionless = () => Session.setData({ sessionId: 'boot', user: undefined, data: {} });

const grantsOn = async (resourceId: string): Promise<AccessGrant[]> => {
  const qb = new QueryBuilderFactory()
    .getQueryBuilder(tables.AccessGrant)
    .condition({ field: 'resource', operator: '=', value: resourceId })
    .condition({ field: 'resourceTable', operator: '=', value: sharedItemTable.name });
  return await getDbAsSystem().query(tables.AccessGrant, qb);
};

const allGrants = async (): Promise<AccessGrant[]> => await getDbAsSystem().query(tables.AccessGrant, {});

/** The typed refusal, by name tag (the house convention for cross-package error identity). */
const expectMalformedRefusal = async (write: Promise<unknown>) => {
  let caught: unknown;
  try {
    await write;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(isMalformedAccessGrantError(caught)).toBe(true);
};

describe('AccessGrant well-formedness invariant', () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      { getDbDriver: () => dbDriver },
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [tables.AccessGrant, sharedItemTable];
    (SourceRepository.get() as any).objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [userRepo];

    runAs(0);

    if (dbDriver.start) {
      await dbDriver.start();
    }

    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => dbDriver);
  });

  beforeEach(async () => {
    await dbDriver.getTableManager().loadTable(sharedItemTable);
    await dbDriver.getTableManager().loadTable(tables.AccessGrant);
    runAs(0);
  });

  afterEach(async () => {
    await dropTable(sharedItemTable);
    await dropTable(new AccessGrantTable());
  });

  afterAll(() => {
    if (dbDriver.stop) {
      dbDriver.stop();
    }
  });

  it('refuses a SYSTEM insert whose principal reference has no id — no row lands', async () => {
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'owned by user0' });
    const before = (await grantsOn(item.id)).length;

    await expectMalformedRefusal(
      getDbAsSystem().insert(tables.AccessGrant, {
        principal: new Reference('user', undefined),
        resource: new Reference(sharedItemTable.name, item.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'read',
      })
    );

    const after = await grantsOn(item.id);
    expect(after).toHaveLength(before);
    expect(after.every((grant) => !!grant.principal?._id && !!grant.resource?._id)).toBe(true);
  });

  it('refuses a SYSTEM insert whose resource reference has no id — no row lands', async () => {
    const before = (await allGrants()).length;

    await expectMalformedRefusal(
      getDbAsSystem().insert(tables.AccessGrant, {
        principal: new Reference('user', users[1].id),
        resource: new Reference(sharedItemTable.name, undefined),
        resourceTable: sharedItemTable.name,
        accessLevel: 'write',
      })
    );

    expect(await allGrants()).toHaveLength(before);
  });

  it('refuses a CALLER insert with a null principal even from the resource owner (the DbService-reachable shape)', async () => {
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'owned by user0' });
    const before = (await grantsOn(item.id)).length;

    // user0 holds owner on the item (bootstrap) and would otherwise pass the admin/owner gate.
    await expectMalformedRefusal(
      getDb().insert(tables.AccessGrant, {
        principal: null as any,
        resource: new Reference(sharedItemTable.name, item.id),
        resourceTable: sharedItemTable.name,
        accessLevel: 'read',
      })
    );

    expect(await grantsOn(item.id)).toHaveLength(before);
  });

  it('a root created with NO session user lands without a grant — never a principal-less owner grant', async () => {
    runSessionless();
    expect(new UserRepo().getUser().id).toBeUndefined();

    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'created by a background executor' });

    // The row itself lands (system creators are legitimate) …
    expect(await getSharedDbAsSystem().get(sharedItemTable, { id: item.id })).toBeDefined();
    // … with nothing minted for nobody: no grant at all on it, and no malformed row anywhere.
    expect(await grantsOn(item.id)).toHaveLength(0);
    expect((await allGrants()).every((grant) => !!grant.principal?._id && !!grant.resource?._id)).toBe(true);
  });

  it('a root created WITH a session user still gets exactly its owner grant (the bootstrap is intact)', async () => {
    runAs(1);
    const item = await getSharedDbAsSystem().insert(sharedItemTable, { name: 'owned by user1' });

    const grants = await grantsOn(item.id);
    expect(grants.map((grant) => [grant.principal._id, grant.accessLevel])).toEqual([[users[1].id, 'owner']]);
  });
});
