import { getDbAsSystem } from '@proteinjs/db';
import { RolesService, RolesCatalog, UserRepo, tables, USER_PERMISSIONS } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';

/**
 * The ONE write path for user roles (the `user.roles` column is service-protected — generic
 * record writes cannot touch it). Grants and revokes are validated against the roles catalog and
 * audited: the role update and its `role_grant_event` row (actor, target, role, action; `created`
 * is the timestamp) commit in one transaction, so the trail cannot diverge from the grants.
 */
export class Roles implements RolesService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      permission: USER_PERMISSIONS.roles,
    },
  };

  async grantRole(userId: string, role: string): Promise<void> {
    await this.changeRole(userId, role, 'grant');
  }

  async revokeRole(userId: string, role: string): Promise<void> {
    await this.changeRole(userId, role, 'revoke');
  }

  private async changeRole(userId: string, role: string, action: 'grant' | 'revoke'): Promise<void> {
    const logger = new Logger({ name: `Roles.${action}Role` });
    if (!RolesCatalog.isKnownRole(role)) {
      throw new Error(`'${role}' is not a known role. Pick one from the roles catalog.`);
    }

    const db = getDbAsSystem();
    const user = await db.get(tables.User, { id: userId });
    if (!user) {
      throw new Error(`No user found for id: ${userId}`);
    }

    const roles = user.roles ?? [];
    if (action === 'grant' ? roles.includes(role) : !roles.includes(role)) {
      // No change, no audit row: the trail records what happened, not what was re-asked.
      return;
    }

    const newRoles = action === 'grant' ? [...roles, role] : roles.filter((heldRole) => heldRole !== role);
    const actor = new UserRepo().getUser();
    await db.runTransaction(async () => {
      await db.update(tables.User, { id: userId, roles: newRoles });
      await db.insert(tables.RoleGrantEvent, {
        actor: actor.id,
        target: userId,
        role,
        action,
      });
    });
    logger.info({
      message: `Role ${action === 'grant' ? 'granted' : 'revoked'}`,
      obj: { actor: actor.id, target: userId, role },
    });
  }
}
