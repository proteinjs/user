import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { RoleCatalogEntry, tables } from '@proteinjs/user';
import { userCache } from '../src/authorization/userCache';
import { invokeDevLogin } from './devLoginHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };

const ENV_EMAIL = 'dev@test.local';
const OWNER_EMAIL = 'owner@test.local';
const OPS_EMAIL = 'ops@test.local';

/**
 * The dev door's grants precede its session, and the session's user carries them from its FIRST
 * request. `/dev/login` grants (the first-admin door, the role-bootstrap door) and THEN
 * establishes the session; every request under that session builds its user from the account
 * row (`userCache.create` — the per-request session-cache build `wrapRoute` runs), so there is no
 * snapshot taken at the door for a grant to land behind.
 *
 * Pinned because a consumer read a bootstrap admin's refused Save as exactly that ordering (the
 * grant landing after "the session's snapshot"): the hypothesis is settled here — the suite was
 * green at the code it was written against — and it bites if the door ever answers before its
 * grants commit (a deferred grant reads role-less on the first request).
 */
describe('devLogin — the session the door mints carries the grants the door made', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
    DEV_BOOTSTRAP_ADMIN_EMAIL: process.env.DEV_BOOTSTRAP_ADMIN_EMAIL,
    DEV_BOOTSTRAP_ROLES: process.env.DEV_BOOTSTRAP_ROLES,
  };

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
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = ENV_EMAIL;
    process.env.DEV_BOOTSTRAP_ADMIN_EMAIL = OWNER_EMAIL;
    process.env.DEV_BOOTSTRAP_ROLES = `${OPS_EMAIL}:ops`;
    // Every case starts from a fresh database: no accounts, no audit trail, no admin.
    const db = getDbAsSystem();
    await db.delete(tables.RoleGrantEvent, {});
    await db.delete(tables.User, {});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('the first-admin door: the first request under the new session resolves the account WITH admin', async () => {
    const outcome = await invokeDevLogin({ email: OWNER_EMAIL });
    expect(outcome.loggedInAs).toBe(OWNER_EMAIL);

    // The first request under the minted session — the build wrapRoute runs before the route.
    const user = await userCache.create('first-request-after-the-door', outcome.loggedInAs!);

    expect(user.email).toBe(OWNER_EMAIL);
    expect(user.roles).toEqual(['admin']);
  });

  it('the role-bootstrap door: the first request under the new session resolves the account WITH the listed roles', async () => {
    const outcome = await invokeDevLogin({ email: OPS_EMAIL });
    expect(outcome.loggedInAs).toBe(OPS_EMAIL);

    const user = await userCache.create('first-request-after-the-door', outcome.loggedInAs!);

    expect(user.email).toBe(OPS_EMAIL);
    expect(user.roles).toEqual(['ops']);
  });
});
