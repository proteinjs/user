import { Service, serviceFactory } from '@proteinjs/service';
import { UserStatus } from '../tables/UserTable';

export const getSetUserStatusService = serviceFactory<SetUserStatusService>('@proteinjs/user/SetUserStatusService');

/**
 * The ONE write path for a user's account standing. The `user.status` column is
 * service-protected (generic record writes cannot touch it); every change lands here and writes
 * a `user_status_event` audit row (actor, target, status; `created` is the timestamp).
 * Admin-only: deactivation locks the target out of the product (login refused, live sessions
 * stop resolving), so the door is the break-glass role, not a mapped permission.
 */
export interface SetUserStatusService extends Service {
  /** Set a user's standing. Already in that standing: no change, no audit row. */
  setUserStatus(userId: string, status: UserStatus): Promise<void>;
}
