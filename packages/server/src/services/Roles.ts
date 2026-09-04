import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { RolesService, RolesCatalog, UserAuth, UserRepo, tables, USER_PERMISSIONS } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';

/**
 * The ONE write path for user roles (the `user.roles` column is service-protected — generic
 * record writes cannot touch it). Grants and revokes are validated against the roles catalog and
 * audited: the role update and its `role_grant_event` row (actor, target, role, action; `created`
 * is the timestamp) commit in one transaction, so the trail cannot diverge from the grants.
 *
 * Break-glass roles are never granted through the service door — see `changeRole`; revoking one
 * stays allowed. The ONE break-glass grant in code is `bootstrapAdmin`, the dev first-admin door
 * (server-internal; reachable only through `/dev/login`'s gates, never over RPC).
 *
 * Nobody edits their OWN roles: separating 'roles' from 'users' means nothing if the holder can
 * simply grant themselves more, and a self-revoke is the mirror hazard (the last holder locking
 * themselves out). Both directions are refused — see `changeRole`; ask another user manager.
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

  /**
   * The dev first-admin door's grant — `/dev/login` honoring `DEV_BOOTSTRAP_ADMIN_EMAIL`
   * (routes/devLogin.ts). A fresh dev database has no privileged account to grant from, and the
   * only other path to break-glass is a manual UPDATE in Spanner Studio — right for prod and every
   * clone-backed instance, wrong for a lane's throwaway estate on a real dev database, where raw
   * writes are forbidden. So this grants 'admin' to `email`'s account exactly when NO account
   * carries it yet (the membership test `UserAuth.hasRole` makes, over every row), audited like
   * any grant — actor = the account itself, because the door acts for nobody else. Once an admin
   * exists it never grants again: every later grant rides Admin → Users.
   *
   * Server-internal, like `Signup.createAccount`: absent from `RolesService`, so never
   * RPC-reachable. The caller's two gates (DEVELOPMENT + DEV_AUTO_LOGIN_EMAIL) are the only way
   * in, and test/prod never set the variable.
   */
  async bootstrapAdmin(email: string): Promise<'granted' | 'admin-exists' | 'no-account'> {
    const logger = new Logger({ name: 'Roles.bootstrapAdmin' });
    const db = getDbAsSystem();
    if (await this.adminExists()) {
      return 'admin-exists';
    }

    const user = await db.get(tables.User, { email: email.toLowerCase() });
    if (!user) {
      return 'no-account';
    }

    const roles = user.roles ?? [];
    await db.runTransaction(async () => {
      await db.update(tables.User, { id: user.id, roles: [...roles, 'admin'] });
      await db.insert(tables.RoleGrantEvent, { actor: user.id, target: user.id, role: 'admin', action: 'grant' });
    });
    logger.info({ message: 'Break-glass admin granted by the dev first-admin door', obj: { target: user.id, email } });
    return 'granted';
  }

  private async changeRole(userId: string, role: string, action: 'grant' | 'revoke'): Promise<void> {
    const logger = new Logger({ name: `Roles.${action}Role` });
    const entry = RolesCatalog.getEntry(role);
    if (!entry) {
      throw new Error(`'${role}' is not a known role. Pick one from the roles catalog.`);
    }

    // Break-glass passes every permission check, so no permission-mapped role — including
    // 'roles' — may mint it: the only path to break-glass is a manual UPDATE on the user row
    // in Spanner Studio, by a human, on purpose (and, on a DEV server only, the first-admin door
    // `bootstrapAdmin`). Revoke stays open: de-escalation toward "held by nobody day-to-day"
    // should ride the audited path, not require database access.
    if (entry.breakGlass && action === 'grant') {
      throw new Error(
        `'${role}' is a break-glass role — this service refuses to grant it. The only path to ` +
          `break-glass is a manual UPDATE on the user row in Spanner Studio. (Revoking it here ` +
          `stays allowed.)`
      );
    }

    // Admin-grant-only roles (catalog `adminGrantOnly`) exceed the people-management trust the
    // 'roles' permission carries — only an admin may hand them out. Server-side and fail-closed:
    // the service door admits 'roles' holders, so this check is what keeps a user-admin from
    // granting such a role. Revoke stays open — the break-glass de-escalation precedent above.
    if (entry.adminGrantOnly && action === 'grant' && !UserAuth.hasRole('admin')) {
      throw new Error(
        `'${role}' can only be granted by an admin — the 'roles' grant does not cover it. ` +
          `(Revoking it here stays allowed.)`
      );
    }

    const db = getDbAsSystem();
    const user = await db.get(tables.User, { id: userId });
    if (!user) {
      throw new Error(`No user found for id: ${userId}`);
    }

    // Machine grants live in the MachineAccount declaration and reconcile at boot — git history
    // is their audit ledger, role_grant_event is the HUMAN ledger, and the two never interleave
    // on one row. A runtime grant here would also just be reverted by the next boot.
    if (user.isLoadedFromSource === true) {
      throw new Error(
        `'${user.email}' is a machine account: its roles are declared in code (its MachineAccount ` +
          `declaration) and reverted to the declaration on every boot. Change the declaration instead.`
      );
    }

    const actor = new UserRepo().getUser();
    // Nobody edits their own roles, in either direction. Checked BEFORE the no-change early
    // return, so a self-target is always an error the caller sees rather than a silent no-op,
    // and before the transaction, so a refused act leaves no audit row behind.
    if (userId === actor.id) {
      logger.warn({ message: 'Refused a self-targeted role change', obj: { actor: actor.id, role, action } });
      throw new Error(`You can't ${action} your own roles — ask another user manager.`);
    }

    const roles = user.roles ?? [];
    if (action === 'grant' ? roles.includes(role) : !roles.includes(role)) {
      // No change, no audit row: the trail records what happened, not what was re-asked.
      return;
    }

    const newRoles = action === 'grant' ? [...roles, role] : roles.filter((heldRole) => heldRole !== role);
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

  /** Whether any account carries the break-glass role — `UserAuth.hasRole`'s membership test, over every row. */
  private async adminExists(): Promise<boolean> {
    const qb = new QueryBuilderFactory().getQueryBuilder(tables.User).select({ fields: ['id', 'roles'] });
    const users = await getDbAsSystem().query(tables.User, qb);
    return users.some((user) => (user.roles ?? []).includes('admin'));
  }
}
