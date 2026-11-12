import { User } from '@proteinjs/user';

/**
 * The ONE owner of "may this account open a session as it stands": asked by every step of a
 * sign-in that could open one — the password step (`authenticate`) and the passkey steps after it
 * (`SignInSecondStep`), which re-ask it because an account's standing can change between a
 * sign-in's two requests. The session half of the same gate is `userCache`'s (a live session of a
 * deactivated account resolves as the guest).
 *
 * A deactivated account is refused — unless its deletion is pending (deactivated by the
 * account-deletion flow, not the staff toggle): signing back in IS the cancel signal, and the
 * login door runs the restore before the session and decides. No `purgeAfter` check here: the
 * restore's own claim is the arbiter, so a person beating the purge walker to a just-expired
 * window wins honestly.
 */
export class AccountStanding {
  static readonly DEACTIVATED = 'This account has been deactivated';

  /** The words a sign-in is refused with, or undefined when the account may sign in. */
  refusal(user: Pick<User, 'status' | 'deleteRequestedAt'>): string | undefined {
    if (user.status !== 'deactivated' || user.deleteRequestedAt != null) {
      return undefined;
    }

    return AccountStanding.DEACTIVATED;
  }
}
