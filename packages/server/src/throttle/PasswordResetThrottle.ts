import { SlidingWindow } from './SlidingWindow';
import { StoredWindow } from './StoredWindow';
import { ThrottleWindow } from './SignInThrottle';

/**
 * The password-reset door's two windows (`POST /user/initiate-password-reset`), keyed by digests
 * (`RequestDigests`), never by an address. Both count every request, whether or not the address
 * has an account — a window that only counted real accounts would itself say which addresses
 * have one. Past either window nothing is looked up, minted or mailed; the door's answer is the
 * same sentence as always (see the route).
 *
 * These sit on top of the account row's own five-minute gap between links, which spans replicas
 * (it is stored). The per-address window is a `StoredWindow`: counted in the store the deployment
 * registers (`DefaultThrottleWindowStoreFactory`), so with a shared store it is one count across
 * every replica and survives a deploy; while that store fails it counts in this process's memory
 * (the named fallback, see `StoredWindow`), so the door still mints and mails. The per-client window stays in process memory (`SlidingWindow`), per
 * replica — the second line behind a per-address limit at the load balancer (see
 * `SignInThrottle`).
 */
export class PasswordResetThrottle {
  /**
   * Per client: 10 requests an hour. Someone asking for their own address again, or a household
   * asking for a few addresses, passes; a script sweeping addresses stops at ten.
   */
  private static readonly CLIENT_LIMIT = 10;
  private static readonly CLIENT_WINDOW_MS = 60 * 60 * 1000;

  /**
   * Per address: 3 requests in an hour's window. A person whose mail is slow asks once or twice
   * more; beyond that it is mail aimed at somebody's inbox.
   */
  private static readonly ACCOUNT_LIMIT = 3;
  private static readonly ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

  private readonly clients: SlidingWindow;
  private readonly accounts: StoredWindow;

  constructor(options?: { now?: () => number }) {
    this.clients = new SlidingWindow({
      windowMs: PasswordResetThrottle.CLIENT_WINDOW_MS,
      limit: PasswordResetThrottle.CLIENT_LIMIT,
      now: options?.now,
    });
    this.accounts = new StoredWindow({
      name: 'reset-address',
      windowMs: PasswordResetThrottle.ACCOUNT_WINDOW_MS,
      limit: PasswordResetThrottle.ACCOUNT_LIMIT,
      now: options?.now,
    });
  }

  /** Count this request and answer which window refuses it, if any. */
  async admit(client: string, account: string): Promise<ThrottleWindow | undefined> {
    if (this.clients.hit(client)) {
      return 'client';
    }
    if (await this.accounts.hit(account)) {
      return 'account';
    }
    return undefined;
  }
}

/** The process-wide windows the reset door shares — they must span requests. */
export const passwordResetThrottle = new PasswordResetThrottle();
