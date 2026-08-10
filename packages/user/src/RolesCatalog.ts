import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * A role known to the product. Consumers register entries by implementing this Loadable; admin
 * surfaces render the catalog as a pick-list instead of free text, and the Roles service refuses
 * to grant a role the catalog does not know.
 */
export interface RoleCatalogEntry extends Loadable {
  /** Stable role name stored on user records (e.g. 'ops'). */
  role: string;
  /** What holding this role means, in plain words — shown in admin pick-lists. */
  description: string;
  /**
   * Break-glass roles pass every role and permission check (see `UserAuth`) and are meant to be
   * held by NOBODY day-to-day. Only 'admin' ships with this flag.
   */
  breakGlass?: boolean;
}

export const getRoleCatalogEntries = () =>
  SourceRepository.get().objects<RoleCatalogEntry>('@proteinjs/user/RoleCatalogEntry');

/**
 * The built-in break-glass role: passes every role and permission check. Day-to-day access rides
 * permission-mapped roles; admin exists for bootstrap and emergencies.
 */
export class AdminRole implements RoleCatalogEntry {
  role = 'admin';
  description = 'Break-glass superuser: passes every permission check. Held by nobody day-to-day.';
  breakGlass = true;
}

/**
 * The registry of known roles: the built-in 'admin' plus consumer-registered `RoleCatalogEntry`
 * implementations, deduped by role name (first registration wins; 'admin' cannot be redefined).
 */
export class RolesCatalog {
  static getEntries(): RoleCatalogEntry[] {
    const entries: RoleCatalogEntry[] = [new AdminRole()];
    for (const entry of getRoleCatalogEntries()) {
      if (!entries.some((existing) => existing.role === entry.role)) {
        entries.push(entry);
      }
    }

    return entries;
  }

  static getEntry(role: string): RoleCatalogEntry | undefined {
    return RolesCatalog.getEntries().find((entry) => entry.role === role);
  }

  static isKnownRole(role: string): boolean {
    return !!RolesCatalog.getEntry(role);
  }
}
