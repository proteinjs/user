import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * The consumer app's permission → roles mapping — the one place domain roles meet the abstract
 * PERMISSION slugs generic packages declare (e.g. 'ops', 'dev', 'users', 'roles').
 *
 * Generic code never names consumer roles: services, tables, and pages declare
 * `{ permission: '<slug>' }`, and `UserAuth.hasPermission` resolves the slug through this mapping
 * at runtime. Register exactly one implementation from the consuming app. With no mapping
 * registered, or for a slug the mapping does not know, permission checks DENY — only the
 * break-glass 'admin' role passes unmapped permissions.
 */
export interface PermissionRolesMapping extends Loadable {
  /**
   * @return the roles that satisfy `permission`, or undefined if the permission is unknown
   * (unknown permissions deny)
   */
  getRoles(permission: string): string[] | undefined;
}

export const getPermissionRolesMapping = () =>
  SourceRepository.get().object<PermissionRolesMapping | undefined>('@proteinjs/user-auth/PermissionRolesMapping');
