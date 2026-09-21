import { Logger } from '@proteinjs/logger';
import { User } from '@proteinjs/user';
import { AccountDeletion } from '../services/AccountDeletion';

/**
 * THE one rule for "may this ACCOUNT be given a new session?" — asked by every door that mints
 * one, after the door has settled WHO is asking in its own way (the password login proves a
 * password; the development-only `GET /dev/login` trusts its two gates). The session side of the
 * same gate lives in userCache: a live session whose account is deactivated resolves as the guest.
 * A door that skipped this rule would mint exactly that — a session that looks established and can
 * do nothing.
 *
 * Two questions, in order:
 * 1. {@link refusalFor} — a deactivated account is refused, EXCEPT one deactivated by its own
 *    pending deletion: coming back IS the cancel signal, so it is let through to question 2.
 * 2. {@link restorePendingDeletion} — the restore runs synchronously BEFORE the session exists, so
 *    the first authenticated request sees a whole account; an account the purge already claimed
 *    is refused.
 */
export class SessionAdmission {
  static readonly DEACTIVATED = 'This account has been deactivated';
  static readonly PURGING = 'This account is being deleted and can no longer be restored.';

  private logger = new Logger({ name: 'SessionAdmission' });

  /** The sentence a door answers instead of a session, or undefined when the account's status allows one. */
  refusalFor(user: Pick<User, 'email' | 'status' | 'deleteRequestedAt'>): string | undefined {
    if (user.status !== 'deactivated') {
      return undefined;
    }

    // Pending-deletion accounts (deactivated by the account-deletion flow, not the staff toggle)
    // may come back: the door runs `restorePendingDeletion` next and that decides. No purgeAfter
    // check here: the cancel's CAS claim is the arbiter, so a user beating the purge walker to a
    // just-expired window wins honestly.
    if (user.deleteRequestedAt != null) {
      return undefined;
    }

    this.logger.warn({ message: 'Refused a new session for a deactivated account', obj: { email: user.email } });
    return SessionAdmission.DEACTIVATED;
  }

  /**
   * Cancel-by-return: restores an account whose deletion is pending (a no-op for every other
   * account). Returns the refusal when the purge already claimed it. Throws what the cancel
   * throws — a door decides how much of that its answer may carry.
   */
  async restorePendingDeletion(email: string): Promise<string | undefined> {
    const outcome = await new AccountDeletion().cancelPendingDeletion(email);
    return outcome === 'purging' ? SessionAdmission.PURGING : undefined;
  }
}
