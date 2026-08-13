import { Page } from '@proteinjs/ui';
import { UserAuth } from '@proteinjs/user';
import { canViewPage } from '../src/pageAuth';

/**
 * The page-auth decision `AuthenticatedPageContainer` enforces, including the permission door:
 * pages declare `{ permission: '<slug>' }` and the slug resolves to consumer roles through
 * `UserAuth.hasPermission` (admin passes via break-glass). The default stays admin-when-
 * unspecified.
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed.
 */

type UserAuthInternals = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  permissionRolesMapping?: { getRoles: (permission: string) => string[] | undefined };
};

const setUser = (roles: string[], email = 'user@test.local') => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email, roles }),
  };
};

const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = {
    getRoles: (permission: string) => mapping[permission],
  };
};

const pageWith = (auth: Page['auth']): Page => ({ name: 'test', path: 'test', component: null as any, auth });

describe('canViewPage', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  });

  it('public pages render for anyone; allUsers pages need a login', () => {
    setUser([], 'guest');
    expect(canViewPage(pageWith({ public: true }))).toBe(true);
    expect(canViewPage(pageWith({ allUsers: true }))).toBe(false);

    setUser([]);
    expect(canViewPage(pageWith({ allUsers: true }))).toBe(true);
  });

  it('permission pages render for holders of a mapped role, deny others', () => {
    setMapping({ ops: ['ops'] });
    setUser(['ops']);
    expect(canViewPage(pageWith({ permission: 'ops' }))).toBe(true);

    setUser(['dev']);
    expect(canViewPage(pageWith({ permission: 'ops' }))).toBe(false);
  });

  it('admin passes any permission page (break-glass)', () => {
    setUser(['admin']);
    expect(canViewPage(pageWith({ permission: 'ops' }))).toBe(true);
  });

  it('permission takes precedence over roles when both are set', () => {
    setMapping({ ops: ['ops'] });
    setUser(['legacy-role']);
    expect(canViewPage(pageWith({ permission: 'ops', roles: ['legacy-role'] }))).toBe(false);
  });

  it('roles pages still work; unspecified auth stays admin-only', () => {
    setUser(['ops']);
    expect(canViewPage(pageWith({ roles: ['ops'] }))).toBe(true);
    expect(canViewPage(pageWith(undefined))).toBe(false);

    setUser(['admin']);
    expect(canViewPage(pageWith(undefined))).toBe(true);
  });
});
