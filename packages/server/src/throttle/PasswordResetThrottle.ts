import { SlidingWindow } from './SlidingWindow';
import { ThrottleWindow } from './SignInThrottle';

/**
 * The password-reset door's two windows (`POST /user/initiate-password-reset`), keyed by digests
 * (`RequestDigests`), never by an address. Both count every request, whether or not the address
 * has an account — a window that only counted real accounts would itself say which addresses
 * have one. Past either window nothing is looked up, minted or mailed; the door's answer is the
 * same sentence as always (see the route).
 *
 * These sit on top of the account row's own five-minute gap between links, which spans replicas
 * (it is stored); the windows are in process memory (`SlidingWindow`): per replica. A
 * deployment of three replicas behind a load balancer (up to ten under load) keeps three sets
 * of windows, so its effective ceiling is ~3× the numbers below (up to ~10×) — for one address
 * still at most one mail per five minutes. Friction, not the wall — a shared store is a
 * separate step.
 */
export class PasswordResetThrottle {
  /**
   * Per client: 10 requests an hour. Someone asking for their own address again, or a household
   * asking for a few addresses, passes; a script sweeping addresses stops at ten.
   */
  private static readonly CLIENT_LIMIT = 10;
  private static readonly CLIENT_WINDOW_MS = 60 * 60 * 1000;

  /**
   * Per address: 3 requests an hour. A person whose mail is slow asks once or twice more; beyond
   * that it is mail aimed at somebody's inbox.
   */
  private static readonly ACCOUNT_LIMIT = 3;
  private static readonly ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

  private readonly clients: SlidingWindow;
  private readonly accounts: SlidingWindow;

  constructor(options?: { now?: () => number }) {
    this.clients = new SlidingWindow({
      windowMs: PasswordResetThrottle.CLIENT_WINDOW_MS,
      limit: PasswordResetThrottle.CLIENT_LIMIT,
      now: options?.now,
    });
    this.accounts = new SlidingWindow({
      windowMs: PasswordResetThrottle.ACCOUNT_WINDOW_MS,
      limit: PasswordResetThrottle.ACCOUNT_LIMIT,
      now: options?.now,
    });
  }

  /** Count this request and answer which window refuses it, if any. */
  admit(client: string, account: string): ThrottleWindow | undefined {
    if (this.clients.hit(client)) {
      return 'client';
    }
    if (this.accounts.hit(account)) {
      return 'account';
    }
    return undefined;
  }
}

/** The process-wide windows the reset door shares — they must span requests. */
export const passwordResetThrottle = new PasswordResetThrottle();
