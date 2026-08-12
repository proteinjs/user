import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, AuthenticatedUserRepo } from '../src/UserAuth';
import { PermissionRolesMapping } from '../src/PermissionRolesMapping';

/**
 * Covers the fail-closed contract of the auth primitive: a context with NO registered
 * `AuthenticatedUserRepo` must DENY everything. The pre-flip behavior returned true from
 * `isLoggedIn`/`hasRole`/`hasRoles` when no repo was registered — the inverse of default-deny:
 * any process that loaded the auth package without wiring a user repo passed every admin gate.
 *
 * In-process bundles register the repo through the source graph; contexts that legitimately run
 * without one (driver test harnesses) now register an explicit identity instead of leaning on
 * fail-open (see @proteinjs/db's DbTestEnvironment).
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed.
 * The unregistered case seeds an EMPTY objectCache entry so the SourceRepository lookup resolves
 * to undefined the same way it does in a real bundle with no implementation registered.
 */

const AUTHENTICATED_USER_REPO = '@proteinjs/user-auth/AuthenticatedUserRepo';
const PERMISSION_ROLES_MAPPING = '@proteinjs/user-auth/PermissionRolesMapping';

type UserAuthInternals = { userRepo?: AuthenticatedUserRepo; permissionRolesMapping?: PermissionRolesMapping };

const setUser = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'user@test.local', roles }),
  };
};

const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = {
    getRoles: (permission: string) => mapping[permission],
  };
};

/** No repo or mapping registered anywhere: statics unset, SourceRepository resolves to nothing. */
const clearUserRepo = () => {
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  (SourceRepository.get() as any).objectCache[AUTHENTICATED_USER_REPO] = [];
  (SourceRepository.get() as any).objectCache[PERMISSION_ROLES_MAPPING] = [];
};

describe('UserAuth — fail-closed when no user repo is registered', () => {
  beforeEach(() => {
    clearUserRepo();
  });

  afterEach(() => {
    clearUserRepo();
  });

  it('isLoggedIn denies', () => {
    expect(UserAuth.isLoggedIn()).toBe(false);
  });

  it('hasRole denies, even for admin', () => {
    expect(UserAuth.hasRole('admin')).toBe(false);
    expect(UserAuth.hasRole('ops')).toBe(false);
  });

  it('hasRoles denies in both modes', () => {
    expect(UserAuth.hasRoles(['admin'])).toBe(false);
    expect(UserAuth.hasRoles(['admin', 'ops'], 'at least one')).toBe(false);
  });
});

describe('UserAuth — registered repo behavior is unchanged', () => {
  afterEach(() => {
    clearUserRepo();
  });

  it('guest user is not logged in; a real email is', () => {
    (UserAuth as unknown as UserAuthInternals).userRepo = {
      getUser: () => ({ email: 'guest', roles: [] }),
    };
    expect(UserAuth.isLoggedIn()).toBe(false);

    setUser([]);
    expect(UserAuth.isLoggedIn()).toBe(true);
  });

  it('hasRole matches held roles and denies missing ones', () => {
    setUser(['ops']);
    expect(UserAuth.hasRole('ops')).toBe(true);
    expect(UserAuth.hasRole('dev')).toBe(false);
  });

  it('admin short-circuits every role check (break-glass)', () => {
    setUser(['admin']);
    expect(UserAuth.hasRole('ops')).toBe(true);
    expect(UserAuth.hasRoles(['ops', 'dev'])).toBe(true);
  });

  it('hasRoles honors all vs at-least-one', () => {
    setUser(['ops']);
    expect(UserAuth.hasRoles(['ops', 'dev'])).toBe(false);
    expect(UserAuth.hasRoles(['ops', 'dev'], 'at least one')).toBe(true);
  });
});

describe('UserAuth.hasPermission — permission indirection through the consumer mapping', () => {
  beforeEach(() => {
    clearUserRepo();
  });

  afterEach(() => {
    clearUserRepo();
  });

  it('denies when no user repo is registered (fail-closed)', () => {
    setMapping({ ops: ['ops'] });
    expect(UserAuth.hasPermission('ops')).toBe(false);
  });

  it('grants when the user holds a role the mapping names for the permission', () => {
    setUser(['ops']);
    setMapping({ ops: ['ops', 'sre'] });
    expect(UserAuth.hasPermission('ops')).toBe(true);
  });

  it('denies when the user holds none of the mapped roles', () => {
    setUser(['dev']);
    setMapping({ ops: ['ops'] });
    expect(UserAuth.hasPermission('ops')).toBe(false);
  });

  it('denies unmapped permissions and empty mappings (default deny)', () => {
    setUser(['ops']);
    setMapping({ dev: ['dev'], empty: [] });
    expect(UserAuth.hasPermission('ops')).toBe(false);
    expect(UserAuth.hasPermission('empty')).toBe(false);
  });

  it('denies every permission when no mapping is registered — except for admin', () => {
    setUser(['ops']);
    expect(UserAuth.hasPermission('ops')).toBe(false);

    setUser(['admin']);
    expect(UserAuth.hasPermission('ops')).toBe(true);
  });

  it('admin passes every permission (break-glass), mapped or not', () => {
    setUser(['admin']);
    setMapping({ ops: ['ops'] });
    expect(UserAuth.hasPermission('ops')).toBe(true);
    expect(UserAuth.hasPermission('never-declared')).toBe(true);
  });
});

describe('UserAuth — NULL/absent roles tolerance (the n3xa5 AccountMenu white-screen class)', () => {
  // Pre-roles-backfill user rows read roles as NULL; a repo implementation fed by raw session
  // data can hand that through despite the interface's `string[]` (the runtime shape that
  // white-screened brent-dev-5's menus — every client-side gate funnels through UserAuth, so
  // one `.includes` on null blanked the page). Contract: a null-roles user is simply
  // role-less — every check DENIES, nothing throws. Tolerance only, no invented roles.
  const setUserWithRawRoles = (roles: unknown) => {
    (UserAuth as unknown as UserAuthInternals).userRepo = {
      getUser: () => ({ email: 'legacy@test.local', roles: roles as string[] }),
    };
  };

  beforeEach(() => {
    clearUserRepo();
  });

  afterEach(() => {
    clearUserRepo();
  });

  it.each([null, undefined])('hasRole denies without throwing when roles is %p', (roles) => {
    setUserWithRawRoles(roles);
    expect(UserAuth.hasRole('admin')).toBe(false);
    expect(UserAuth.hasRole('ops')).toBe(false);
  });

  it.each([null, undefined])('hasRoles denies without throwing when roles is %p', (roles) => {
    setUserWithRawRoles(roles);
    expect(UserAuth.hasRoles(['ops'])).toBe(false);
    expect(UserAuth.hasRoles(['ops', 'dev'], 'at least one')).toBe(false);
  });

  it.each([null, undefined])('hasPermission denies without throwing when roles is %p', (roles) => {
    setUserWithRawRoles(roles);
    setMapping({ ops: ['ops'] });
    expect(UserAuth.hasPermission('ops')).toBe(false);
  });

  it('a null-roles user still reads as logged in — role-less, never a crash (the menus render)', () => {
    setUserWithRawRoles(null);
    expect(UserAuth.isLoggedIn()).toBe(true);
  });
});
