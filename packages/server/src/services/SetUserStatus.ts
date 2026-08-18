import { getDbAsSystem } from '@proteinjs/db';
import { SetUserStatusService, USER_STATUSES, UserRepo, UserStatus, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';

/**
 * The ONE write path for a user's account standing (the `user.status` column is
 * service-protected — generic record writes cannot touch it). The status update and its
 * `user_status_event` audit row (actor, target, status; `created` is the timestamp) commit in
 * one transaction, so the trail cannot diverge from the standing.
 *
 * Admin-only by explicit scope: deactivation locks the target out of the product (login refused,
 * live sessions stop resolving via userCache), so the door is the break-glass role, not a mapped
 * permission. This method only flips standing — `deleteRequestedAt`/`purgeAfter` belong to the
 * account-deletion flow.
 */
export class SetUserStatus implements SetUserStatusService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      roles: ['admin'],
    },
  };

  async setUserStatus(userId: string, status: UserStatus): Promise<void> {
    const logger = new Logger({ name: 'SetUserStatus.setUserStatus' });
    if (!USER_STATUSES.includes(status)) {
      throw new Error(`'${status}' is not a known user status. Pick one of: ${USER_STATUSES.join(', ')}.`);
    }

    const db = getDbAsSystem();
    const user = await db.get(tables.User, { id: userId });
    if (!user) {
      throw new Error(`No user found for id: ${userId}`);
    }

    // Rows predating the status column read null, which every gate treats as active.
    if ((user.status ?? 'active') === status) {
      // No change, no audit row: the trail records what happened, not what was re-asked.
      return;
    }

    const actor = new UserRepo().getUser();
    await db.runTransaction(async () => {
      await db.update(tables.User, { id: userId, status });
      await db.insert(tables.UserStatusEvent, {
        actor: actor.id,
        target: userId,
        status,
      });
    });
    logger.info({
      message: `User status set to ${status}`,
      obj: { actor: actor.id, target: userId, status },
    });
  }
}
