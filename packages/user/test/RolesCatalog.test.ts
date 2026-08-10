import { SourceRepository } from '@proteinjs/reflection';
import { AdminRole, RoleCatalogEntry, RolesCatalog } from '../src/RolesCatalog';

/**
 * The roles catalog backs the admin pick-list and the Roles service's grant validation: known
 * roles are the built-in break-glass 'admin' plus consumer-registered `RoleCatalogEntry`
 * implementations. Registration rides the SourceRepository like every Loadable; tests seed the
 * objectCache the same way the shared-record suite does.
 */

const ROLE_CATALOG_ENTRY = '@proteinjs/user/RoleCatalogEntry';

const registerEntries = (entries: RoleCatalogEntry[]) => {
  (SourceRepository.get() as any).objectCache[ROLE_CATALOG_ENTRY] = entries;
};

describe('RolesCatalog', () => {
  afterEach(() => {
    registerEntries([]);
  });

  it(`always contains the built-in break-glass admin role, even with nothing registered`, () => {
    registerEntries([]);
    const admin = RolesCatalog.getEntry('admin');
    expect(admin).toBeDefined();
    expect(admin!.breakGlass).toBe(true);
    expect(admin!.description.length).toBeGreaterThan(0);
  });

  it('lists consumer-registered roles beside admin', () => {
    registerEntries([
      { role: 'ops', description: 'Run the ops cockpit' },
      { role: 'dev', description: 'Use dev tools' },
    ]);
    const roles = RolesCatalog.getEntries().map((entry) => entry.role);
    expect(roles).toEqual(['admin', 'ops', 'dev']);
    expect(RolesCatalog.isKnownRole('ops')).toBe(true);
    expect(RolesCatalog.isKnownRole('made-up')).toBe(false);
  });

  it(`admin cannot be redefined by a consumer entry (the built-in wins)`, () => {
    registerEntries([{ role: 'admin', description: 'not break-glass', breakGlass: false }]);
    const entries = RolesCatalog.getEntries().filter((entry) => entry.role === 'admin');
    expect(entries).toHaveLength(1);
    expect(entries[0].breakGlass).toBe(true);
  });

  it(`the reflection registration of the built-in AdminRole dedupes against the built-in`, () => {
    // In a real bundle the source graph registers AdminRole itself; the catalog must not list
    // admin twice.
    registerEntries([new AdminRole()]);
    expect(RolesCatalog.getEntries().filter((entry) => entry.role === 'admin')).toHaveLength(1);
  });
});
