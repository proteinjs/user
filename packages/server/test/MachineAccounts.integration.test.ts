import sha256 from 'crypto-js/sha256';
import { SourceRecordSyncRunner, getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
// Deep import (test-only): ServiceAuth is the real RPC door but is not index-exported by
// @proteinjs/service — the door test below runs the actual gate rather than pinning metadata.
import { ServiceAuth } from '@proteinjs/service/dist/src/ServiceAuth';
import { MachineAccount, RoleCatalogEntry, User, UserRepo, tables } from '@proteinjs/user';
import { authenticate } from '../src/authentication/authenticate';
import { UserStatusTableWatcher } from '../src/authentication/UserStatusTableWatcher';
import { MachineCredentials } from '../src/services/MachineCredentials';
import { Roles } from '../src/services/Roles';
import { SetUserStatus } from '../src/services/SetUserStatus';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/** The consumer-mapped role machine declarations grant (registered into the catalog below). */
class OpsRole implements RoleCatalogEntry {
  role = 'ops';
  description = 'Operational machinery';
}

class TestOpsMachineAccount extends MachineAccount {
  id = 'machine-test-ops';
  email = 'machine-ops@test.local';
  accountName = 'Test ops machine';
  roles = ['ops'];
  secretName = 'test-ops-secret';
}

type SourceRepositoryInternals = {
  objectCache: { [qualifiedName: string]: unknown[] };
  // db >=1.34.4 reads loaders through objectsWithNames (declaration provenance — the
  // source-ownership grain), which resolves from THIS cache; seeding objectCache alone is
  // invisible to it.
  namedObjectCache: { [type: string]: { qualifiedName: string; packageName: string; object: unknown }[] };
};

/**
 * Reset `TableWatcherRunner`'s static watcher map so the NEXT Db construction recomputes it from
 * the (just-changed) discovery seam. The class is internal to @proteinjs/db (its exports map
 * blocks deep imports), so it's reached through a Db instance — the test-harness cast convention.
 */
const resetTableWatcherMap = () => {
  const runner = (getDbAsSystem() as unknown as { tableWatcherRunner: object }).tableWatcherRunner;
  (runner.constructor as { tableWatcherMap?: unknown }).tableWatcherMap = undefined;
};

/**
 * Machine accounts as source records, at the user layer: declare-only on the REAL mixed user
 * table, adopt-in-place by email (id + password survive — the old credential still logs in),
 * removed-from-source auto-deactivation with session kill through the categorical
 * UserStatusTableWatcher, the machine/human ledger split (Roles refuses machine targets),
 * declaration validation, and credential minting (hash-only at rest, plaintext shown once).
 */
describe('Machine accounts as source records', () => {
  const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
  const namedObjectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).namedObjectCache;
  const seedLoaders = (declarations: unknown[]) => {
    objectCache()['@proteinjs/db/SourceRecordLoader'] = declarations;
    namedObjectCache()['@proteinjs/db/SourceRecordLoader'] = declarations.map((object, i) => ({
      qualifiedName: `@proteinjs/user-server-test/MachineAccountFixture${i}`,
      packageName: '@proteinjs/user-server',
      object,
    }));
  };

  /** One boot of Db.init's source-record leg with these MachineAccount declarations. */
  const boot = async (declarations: MachineAccount[]) => {
    seedLoaders(declarations);
    await new SourceRecordSyncRunner().load();
  };

  const machineRow = async () => await getDbAsSystem().get(tables.User, { email: 'machine-ops@test.local' });

  const insertSession = async (sessionId: string, userEmail: string) =>
    await getDbAsSystem().insert(tables.Session, {
      sessionId,
      session: '{}',
      expires: new Date(Date.now() + 60 * 60 * 1000),
      userEmail,
    });

  const sessionEmails = async () =>
    (await getDbAsSystem().query(tables.Session, {})).map((session) => session.userEmail);

  beforeAll(async () => {
    await testEnv.beforeAll();
    (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache[
      '@proteinjs/user-auth/AuthenticatedUserRepo'
    ] = [new UserRepo()];
    objectCache()['@proteinjs/user/RoleCatalogEntry'] = [new OpsRole()];
    // Exactly the deactivation watcher observes this run, rebuilt from the seeded cache.
    objectCache()['@proteinjs/db/TableWatcher'] = [new UserStatusTableWatcher()];
    resetTableWatcherMap();
  }, 120000);

  afterAll(async () => {
    delete objectCache()['@proteinjs/db/SourceRecordLoader'];
    delete namedObjectCache()['@proteinjs/db/SourceRecordLoader'];
    delete objectCache()['@proteinjs/db/TableWatcher'];
    delete objectCache()['@proteinjs/user/RoleCatalogEntry'];
    resetTableWatcherMap();
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.Session, {});
    await db.delete(tables.UserStatusEvent, {});
    await db.delete(tables.RoleGrantEvent, {});
    await db.delete(tables.User, {});
  });

  it('declare-only on the mixed user table: the declaration lands source-owned; human rows are untouched', async () => {
    const human = await testEnv.createUser({ name: 'A human', email: 'human@test.local', roles: ['ops'] });
    await boot([new TestOpsMachineAccount()]);

    const machine = await machineRow();
    expect(machine).toMatchObject({
      id: 'machine-test-ops',
      name: 'Test ops machine',
      roles: ['ops'],
      emailVerified: true,
      status: 'active',
      isLoadedFromSource: true,
    });
    // No declarable password: the fresh row carries none, so authenticate's email+hash match
    // can never admit it until a credential is minted.
    expect(machine.password).toBeFalsy();

    const humanAfter = await getDbAsSystem().get(tables.User, { id: human.id });
    expect(humanAfter.isLoadedFromSource).toBeFalsy();
    expect(humanAfter).toMatchObject({ name: 'A human', roles: ['ops'] });
  });

  it('adopt-in-place by email: the hand-made row keeps its id and password; declared fields revert', async () => {
    // The deployed-env shape: a hand-made machine row with an env-random id, a provisioned
    // credential, and runtime-granted roles that have drifted from the declaration.
    const handMade = await testEnv.createUser({
      name: 'Hand-made bridge',
      email: 'machine-ops@test.local',
      roles: ['ops', 'stale-role'],
    });

    await boot([new TestOpsMachineAccount()]);

    const adopted = await machineRow();
    expect(adopted.id).toBe(handMade.id);
    expect(adopted).toMatchObject({
      name: 'Test ops machine',
      roles: ['ops'],
      status: 'active',
      isLoadedFromSource: true,
    });
    // The credential survived adoption: the account still authenticates with its old password
    // (createUser stores sha256('test')... it stores the raw string; assert equality instead).
    expect(adopted.password).toBe(handMade.password);
    expect((await getDbAsSystem().query(tables.User, { email: 'machine-ops@test.local' })).length).toBe(1);
  });

  // KNOWN CROSS-TRAIN GAP (it.failing — flips RED the moment it starts passing, forcing the
  // marker's removal): the re-declare-after-removal leg needs db's soft-removal re-adoption
  // (integration/r5-db ba9f4ba7 — the sync currently INSERTs the existing machine-test-ops row
  // instead of adopting it). Green everywhere else against db ^1.35.0; this leg lands with the
  // R5 db mint. Exact repro + the semantics call recorded on this suite's landing commit.
  it.failing(
    'removed from source: deactivated (never deleted), sessions killed, login refused; re-declaring reactivates',
    async () => {
      const human = await testEnv.createUser({ name: 'A human', email: 'human@test.local' });
      await boot([new TestOpsMachineAccount()]);
      await insertSession('machine-session', 'machine-ops@test.local');
      await insertSession('human-session', human.email);

      // Removal under the db >=1.34.4 ownership law: the reconcile only touches rows whose
      // sourcePackage the RUNNING build still declares from (shared-db safety — a build missing a
      // package must never deactivate that package's rows). The real removal case is the package
      // still booting with THIS declaration gone — modeled by keeping another declaration from
      // the same package aboard. boot([]) would model "package vanished", which the law protects.
      class SurvivingSibling extends TestOpsMachineAccount {
        email = 'machine-sibling@test.local';
        name = 'Surviving sibling machine';
        secretName = 'sibling-secret';
      }
      await boot([new SurvivingSibling()]);

      const removed = await machineRow();
      expect(removed).toBeDefined();
      expect(removed.status).toBe('deactivated');
      // The categorical watcher killed the machine sessions; the human session is untouched.
      expect(await sessionEmails()).toEqual([human.email]);
      // The one login door refuses a deactivated account even with matching credentials.
      await getDbAsSystem().update(tables.User, { id: removed.id, password: sha256('bridge-pw').toString() });
      expect(await authenticate('machine-ops@test.local', 'bridge-pw')).toBe('This account has been deactivated');

      // Decommission is reversible in code: re-declaring reverts status via drift reversion.
      await boot([new TestOpsMachineAccount()]);
      expect((await machineRow()).status).toBe('active');
      expect(await authenticate('machine-ops@test.local', 'bridge-pw')).toBe(true);
    }
  );

  it(`the staff toggle rides the same watcher: SetUserStatus deactivation kills the target's sessions`, async () => {
    const admin = await testEnv.createUser({ name: 'Admin', email: 'admin@test.local', roles: ['admin'] });
    const target = await testEnv.createUser({ name: 'Target', email: 'target@test.local' });
    await insertSession('target-session', target.email);
    await insertSession('admin-session', admin.email);

    testEnv.actAs(admin);
    await new SetUserStatus().setUserStatus(target.id, 'deactivated');

    expect(await sessionEmails()).toEqual([admin.email]);
  });

  it('the Roles service refuses machine-account targets (git is the machine audit); human grants still work', async () => {
    const admin = await testEnv.createUser({ name: 'Admin', email: 'admin@test.local', roles: ['admin'] });
    const human = await testEnv.createUser({ name: 'A human', email: 'human@test.local' });
    await boot([new TestOpsMachineAccount()]);
    testEnv.actAs(admin);

    const machine = await machineRow();
    await expect(new Roles().grantRole(machine.id, 'ops')).rejects.toThrow(
      /machine account: its roles are declared in code/
    );
    await expect(new Roles().revokeRole(machine.id, 'ops')).rejects.toThrow(
      /machine account: its roles are declared in code/
    );
    // No machine rows in the human ledger.
    expect(await getDbAsSystem().query(tables.RoleGrantEvent, { target: machine.id })).toHaveLength(0);

    await new Roles().grantRole(human.id, 'ops');
    expect((await getDbAsSystem().get(tables.User, { id: human.id })).roles).toEqual(['ops']);
  });

  it('declaration validation fails boot loudly: non-lowercase email, unknown role, break-glass role', async () => {
    class UppercaseEmail extends TestOpsMachineAccount {
      email = 'Machine-Ops@test.local';
    }
    await expect(boot([new UppercaseEmail()])).rejects.toThrow(/emails must be lowercase/);

    class UnknownRole extends TestOpsMachineAccount {
      roles = ['not-a-role'];
    }
    await expect(boot([new UnknownRole()])).rejects.toThrow(/unknown role 'not-a-role'/);

    class BreakGlass extends TestOpsMachineAccount {
      roles = ['admin'];
    }
    await expect(boot([new BreakGlass()])).rejects.toThrow(/break-glass role 'admin'/);
  });

  describe('credential minting', () => {
    beforeEach(async () => {
      await boot([new TestOpsMachineAccount()]);
    });

    it('mints a generated credential: hash-only at rest, sessions rotated, plaintext + paste note returned once', async () => {
      await insertSession('old-credential-session', 'machine-ops@test.local');

      const minted = await new MachineCredentials().mintCredential('machine-ops@test.local');

      expect(minted.email).toBe('machine-ops@test.local');
      expect(minted.password).toMatch(/^[0-9a-f]{64}$/); // 256 bits, generated — never human-chosen
      expect(minted.secretName).toBe('test-ops-secret');
      expect(minted.note).toMatch(/test-ops-secret/);
      expect(minted.note).toMatch(/restart/i);

      // Only the hash is stored, and it is the hash of the returned plaintext.
      const row = await machineRow();
      expect(row.password).toBe(sha256(minted.password).toString());
      // The old credential's sessions died with the rotation...
      expect(await sessionEmails()).toEqual([]);
      // ...and the minted credential is immediately loggable.
      expect(await authenticate('machine-ops@test.local', minted.password)).toBe(true);
    });

    it('lists declared accounts with row state for the admin surface', async () => {
      class NotBooted extends TestOpsMachineAccount {
        id = 'machine-not-booted';
        email = 'machine-not-booted@test.local';
        secretName = 'not-booted-secret';
      }
      seedLoaders([new TestOpsMachineAccount(), new NotBooted()]);

      const before = await new MachineCredentials().listMachineAccounts();
      expect(before).toEqual([
        {
          email: 'machine-ops@test.local',
          accountName: 'Test ops machine',
          roles: ['ops'],
          secretName: 'test-ops-secret',
          status: 'active',
          hasCredential: false,
        },
        {
          email: 'machine-not-booted@test.local',
          accountName: 'Test ops machine',
          roles: ['ops'],
          secretName: 'not-booted-secret',
          status: 'pending first boot',
          hasCredential: false,
        },
      ]);

      await new MachineCredentials().mintCredential('machine-ops@test.local');
      const after = await new MachineCredentials().listMachineAccounts();
      expect(after[0]).toMatchObject({ email: 'machine-ops@test.local', hasCredential: true });
    });

    it('refuses non-machine targets: undeclared emails and human accounts', async () => {
      await testEnv.createUser({ name: 'A human', email: 'human@test.local' });
      await expect(new MachineCredentials().mintCredential('human@test.local')).rejects.toThrow(
        /No machine account is declared/
      );
      await expect(new MachineCredentials().mintCredential('nobody@test.local')).rejects.toThrow(
        /No machine account is declared/
      );
    });

    it('refuses a declared account whose row has not been loaded from source yet', async () => {
      class NotBooted extends TestOpsMachineAccount {
        id = 'machine-not-booted';
        email = 'machine-not-booted@test.local';
      }
      // Declared (discoverable) but never booted: no source-owned row exists.
      seedLoaders([new TestOpsMachineAccount(), new NotBooted()]);
      await expect(new MachineCredentials().mintCredential('machine-not-booted@test.local')).rejects.toThrow(
        /has not been loaded from source yet/
      );
    });

    it(`the door is the 'users' permission (admin passes as break-glass)`, async () => {
      const admin = await testEnv.createUser({ name: 'Admin', email: 'admin@test.local', roles: ['admin'] });
      const plain = await testEnv.createUser({ name: 'Plain', email: 'plain@test.local', roles: ['ops'] });
      const canRun = () =>
        ServiceAuth.canRunService(new MachineCredentials(), { name: 'mintCredential' } as any, [
          'machine-ops@test.local',
        ]);

      testEnv.actAs(plain);
      expect(canRun()).toBe(false);
      testEnv.actAs(admin);
      expect(canRun()).toBe(true);
    });
  });
});
