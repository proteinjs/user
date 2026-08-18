import { Service, serviceFactory } from '@proteinjs/service';
import { Moment } from 'moment';

export const getAccountDeletionService = serviceFactory<AccountDeletionService>(
  '@proteinjs/user/AccountDeletionService'
);

/**
 * In-app account deletion, archive-then-purge: the synchronous call deactivates the account
 * ("gone right away" — shares revoked both directions, sessions killed), and the background
 * purge walker erases everything after the grace window. Logging back in during grace cancels
 * (full restore, including shares — the login route runs the cancel hook, not this service).
 *
 * Acts ONLY on the session user — no target parameter, so the only authz surface beyond the
 * door is the password re-auth inside the call. Door: any authenticated user (`allUsers`,
 * declared on the implementation's serviceMetadata).
 */
export interface AccountDeletionService extends Service {
  /**
   * Deactivate the session user's account and schedule the purge. Idempotent: a re-call after a
   * partial failure resumes from the stored deletion manifest (never re-enumerates). The
   * caller's sessions are killed last — the response is the last authenticated exchange.
   *
   * @param password re-auth — must match the session user's password
   * @returns the purge date, for the UI's confirmation copy
   */
  requestDeletion(password: string): Promise<{ purgeAfter: Moment }>;
}
