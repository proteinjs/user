import { Service, serviceFactory } from '@proteinjs/service';

export const getRolesService = serviceFactory<RolesService>('@proteinjs/user/RolesService');

/**
 * The ONE write path for user roles. The `user.roles` column is service-protected (generic
 * record writes cannot touch it); every change lands here, is validated against the roles
 * catalog, and writes a `role_grant_event` audit row (actor, target, role, action; `created` is
 * the timestamp). Requires the 'roles' permission.
 */
export interface RolesService extends Service {
  /** Add a catalog role to a user. Already held: no change, no audit row. */
  grantRole(userId: string, role: string): Promise<void>;
  /** Remove a role from a user. Not held: no change, no audit row. */
  revokeRole(userId: string, role: string): Promise<void>;
}
