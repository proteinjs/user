import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { guestUser } from './guestUser';
import { PermissionRolesMapping, getPermissionRolesMapping } from './PermissionRolesMapping';

export interface AuthenticatedUser {
  email: string;
  roles: string[];
}

export interface AuthenticatedUserRepo extends Loadable {
  getUser(): AuthenticatedUser;
}

export const getAuthenticatedUserRepo = () =>
  SourceRepository.get().object<AuthenticatedUserRepo | undefined>('@proteinjs/user-auth/AuthenticatedUserRepo');

/**
 * The auth primitive every gate funnels through (ServiceAuth, TableAuth, page auth).
 *
 * FAIL-CLOSED: a context with no registered `AuthenticatedUserRepo` denies everything. In-process
 * bundles register the repo through the source graph (@proteinjs/user's UserRepo); a context that
 * legitimately runs without one must register an explicit identity or use system paths
 * (`getDbAsSystem`) — never lean on the gate being open.
 *
 * 'admin' is the BREAK-GLASS role: it short-circuits every role and permission check. Day-to-day
 * access rides permissions resolved through the consumer's `PermissionRolesMapping`.
 */
export class UserAuth {
  private static userRepo?: AuthenticatedUserRepo;
  private static permissionRolesMapping?: PermissionRolesMapping;

  static isLoggedIn(): boolean {
    const userRepo = UserAuth.getUserRepo();
    if (!userRepo) {
      return false;
    }

    const user = userRepo.getUser();
    return user.email != guestUser.email;
  }

  /**
   * @return true if user has role or user has role 'admin'
   */
  static hasRole(role: string): boolean {
    const userRepo = UserAuth.getUserRepo();
    if (!userRepo) {
      return false;
    }

    const user = userRepo.getUser();
    if (user.roles.includes('admin')) {
      return true;
    }

    return user.roles.includes(role);
  }

  /**
   * @param has (default) `all` - return true if user has all roles
   * @param has `at least one` - return true if user has at least one role
   */
  static hasRoles(roles: string[], has: 'all' | 'at least one' = 'all'): boolean {
    const userRepo = UserAuth.getUserRepo();
    if (!userRepo) {
      return false;
    }

    for (const role of roles) {
      if (!UserAuth.hasRole(role)) {
        if (has === 'all') {
          return false;
        }
      } else {
        if (has === 'at least one') {
          return true;
        }
      }
    }

    return has === 'all';
  }

  /**
   * Resolve an abstract permission slug through the consumer-registered `PermissionRolesMapping`:
   * true if the user holds at least one of the roles the mapping names for `permission`.
   *
   * 'admin' passes every permission (break-glass). With no mapping registered, or a slug the
   * mapping does not know, everyone else is denied.
   */
  static hasPermission(permission: string): boolean {
    const userRepo = UserAuth.getUserRepo();
    if (!userRepo) {
      return false;
    }

    const user = userRepo.getUser();
    if (user.roles.includes('admin')) {
      return true;
    }

    const mapping = UserAuth.getPermissionRolesMapping();
    if (!mapping) {
      return false;
    }

    const roles = mapping.getRoles(permission);
    if (!roles || roles.length === 0) {
      return false;
    }

    return roles.some((role) => user.roles.includes(role));
  }

  private static getUserRepo() {
    if (!UserAuth.userRepo) {
      UserAuth.userRepo = getAuthenticatedUserRepo();
    }

    return UserAuth.userRepo;
  }

  private static getPermissionRolesMapping() {
    if (!UserAuth.permissionRolesMapping) {
      UserAuth.permissionRolesMapping = getPermissionRolesMapping();
    }

    return UserAuth.permissionRolesMapping;
  }
}
