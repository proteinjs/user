import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { RoleCatalogEntry, tables } from '@proteinjs/user';
import { userCache } from '../src/authorization/userCache';
import { Roles } from '../src/services/Roles';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };

/**
 * A role granted AFTER a person signed in is honoured by their very next request — no new
 * sign-in. The session names the account; the account row holds the roles; `userCache.create`
 * (the per-request session-cache build `wrapRoute` runs, and the socket road's per-event build)
 * reads the row on every request, so there is no cache entry a grant could leave stale — the
 * window is one request, on the HTTP road and the socket road alike.
 *
 * Pinned because a consumer read the opposite into a refused Save ("an admin granted from the
 * user manager is not admin until the next sign-in"): the hypothesis is settled here — the suite
 * was green at the code it was written against — and it bites if the build ever memoizes across
 * requests.
 */
describe('a role granted while a session stands is honoured on the next request', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
    (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache['@proteinjs/user/RoleCatalogEntry'] = [
      { role: 'ops', description: 'Operations' } as RoleCatalogEntry,
    ];
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.RoleGrantEvent, {});
    await db.delete(tables.User, {});
  });

  it('a user manager grants a catalog role: the next request carries it; a revoke drops it the same way', async () => {
    const person = await testEnv.createUser({ name: 'Signed-in person', email: 'granted-later@test.local' });
    const manager = await testEnv.createUser({ name: 'User manager', email: 'manager@test.local', roles: ['admin'] });
    const sessionId = 'standing-session';
    const before = await userCache.create(sessionId, person.email);
    expect(before.roles).toEqual([]);

    testEnv.actAs(manager);
    await new Roles().grantRole(person.id, 'ops');

    const after = await userCache.create(sessionId, person.email);
    expect(after.roles).toEqual(['ops']);

    await new Roles().revokeRole(person.id, 'ops');

    const later = await userCache.create(sessionId, person.email);
    expect(later.roles).toEqual([]);
  });

  it('the break-glass grant (the dev first-admin door) is honoured on the next request the same way', async () => {
    const person = await testEnv.createUser({ name: 'First admin', email: 'first-admin@test.local' });
    const sessionId = 'standing-session';
    expect((await userCache.create(sessionId, person.email)).roles).toEqual([]);

    expect(await new Roles().bootstrapAdmin(person.email)).toBe('granted');

    expect((await userCache.create(sessionId, person.email)).roles).toEqual(['admin']);
  });
});
