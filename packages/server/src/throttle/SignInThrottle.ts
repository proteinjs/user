import { SlidingWindow } from './SlidingWindow';

/** Which window refused a try: the client's (its coarse IP hash) or the account's (its digest). */
export type ThrottleWindow = 'client' | 'account';

/**
 * The sign-in door's two windows (`POST /user/login`), keyed by digests (`RequestDigests`),
 * never by an address:
 * - per CLIENT: every try that is not a success counts — wrong passwords, blank ones too, the
 *   client made them — so one device cannot sweep many accounts; a successful sign-in never
 *   counts (it is forgiven the moment it succeeds), so the people behind one shared address
 *   signing in do not spend the window on each other;
 * - per ACCOUNT: every try that carries a password counts (a blank submission judges no
 *   password, so it never counts), so guesses spread over many devices still stop; a success
 *   clears the account's count. A try is counted as it ARRIVES, before it is judged: tries in
 *   flight at the same moment cannot all pass the window together.
 *
 * A throttled try is told `ANSWER` whichever window refused it and whether or not the address
 * has an account, in the same time a refused password takes (the door runs the same password
 * check and discards its verdict).
 *
 * The windows are in process memory (`SlidingWindow`): per replica. A deployment of three
 * replicas behind a load balancer (up to ten under load) keeps three sets of windows, so its
 * effective ceiling is ~3× the numbers below (up to ~10×). Friction, not the wall — a shared
 * store is a separate step.
 */
export class SignInThrottle {
  /** What a throttled try is told — in plain words, the same for every address, known or not. */
  static readonly ANSWER = 'Too many attempts. Try again in a few minutes.';

  /**
   * Per client: 50 tries that are not successes in 10 minutes (the founder's number, 2026-09-23).
   * Successes never count, so an office or a school behind one address signing in at nine o'clock
   * never spends this window on itself — only its mistypes do, and fifty wrong or blank tries in
   * ten minutes is beyond any human population behind one address; a guessing script from one
   * device is held to ~300 tries an hour per replica.
   */
  private static readonly CLIENT_LIMIT = 50;
  private static readonly CLIENT_WINDOW_MS = 10 * 60 * 1000;

  /**
   * Per account: 10 tries in 15 minutes (a success clears them, so only wrong ones ever add up).
   * Someone who has forgotten a password tries a handful and asks for a reset link; ten wrong in
   * a quarter of an hour is guessing, and counting per account holds however many devices the
   * guesses come from. "A few minutes" in the answer is honest: the oldest try leaves the window
   * within 15.
   */
  private static readonly ACCOUNT_LIMIT = 10;
  private static readonly ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

  private readonly clients: SlidingWindow;
  private readonly accounts: SlidingWindow;

  constructor(options?: { now?: () => number }) {
    this.clients = new SlidingWindow({
      windowMs: SignInThrottle.CLIENT_WINDOW_MS,
      limit: SignInThrottle.CLIENT_LIMIT,
      now: options?.now,
    });
    this.accounts = new SlidingWindow({
      windowMs: SignInThrottle.ACCOUNT_WINDOW_MS,
      limit: SignInThrottle.ACCOUNT_LIMIT,
      now: options?.now,
    });
  }

  /**
   * Count this try against the client and against the account, and answer which window refuses
   * it, if any. `account` is the digest of the address tried, given only when a password came
   * with it (a blank submission judges no password, so it never counts toward an account). The
   * count is taken here, before the try is judged, so tries in flight at once cannot all pass
   * the window; a success clears it (`recordSuccess`).
   */
  admit(client: string, account?: string): ThrottleWindow | undefined {
    if (this.clients.hit(client)) {
      return 'client';
    }
    if (account !== undefined && this.accounts.hit(account)) {
      return 'account';
    }
    return undefined;
  }

  /**
   * The account proved itself: its window opens again. When it was a sign-in try from `client`
   * (rather than a reset link redeemed), that try is forgiven — a success never counts against
   * the device.
   */
  recordSuccess(account: string, client?: string): void {
    this.accounts.clear(account);
    if (client !== undefined) {
      this.clients.forgive(client);
    }
  }
}

/** The process-wide windows the sign-in door shares — they must span requests. */
export const signInThrottle = new SignInThrottle();
