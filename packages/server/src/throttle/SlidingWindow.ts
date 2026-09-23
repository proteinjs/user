/**
 * A per-key sliding window: how many attempts a key made in the last `windowMs`, against a
 * `limit`. The one window every throttled door shares — the sign-in and password-reset doors in
 * this package, and any consumer door throttling per client (lifted from the invite-request
 * door's per-IP throttle, which it replaces).
 *
 * Held in process memory only, which is what makes it cheap and what bounds it:
 * - PER PROCESS. Each replica keeps its own windows, so behind a load balancer spreading a
 *   client over N replicas the effective ceiling is ~N× the limit; a restart forgets them.
 *   A throttle built on this is friction, not the wall. A shared store is a separate step.
 * - BOUNDED. At most `maxKeys` keys are tracked; at the bound the oldest-touched key is
 *   forgotten first, so a flood of fresh keys degrades the friction before it grows memory.
 *
 * Keys are whatever the caller passes — callers pass digests (see `RequestDigests`), never raw
 * addresses, so nothing identifying is held here either.
 */
export class SlidingWindow {
  private static readonly DEFAULT_MAX_KEYS = 10_000;

  private readonly windowMs: number;
  private readonly limit: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  /** key → the counted attempt times inside the window (pruned on touch), in touch order. */
  private readonly attempts = new Map<string, number[]>();

  constructor(options: { windowMs: number; limit: number; maxKeys?: number; now?: () => number }) {
    this.windowMs = options.windowMs;
    this.limit = options.limit;
    this.maxKeys = options.maxKeys ?? SlidingWindow.DEFAULT_MAX_KEYS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record an attempt for `key` and answer whether it was over the window — `true` means refuse.
   * A refused attempt is not counted, so a key drains one window after its last counted attempt.
   */
  hit(key: string): boolean {
    if (this.isOver(key)) {
      this.touch(key, this.inWindow(key));
      return true;
    }
    this.record(key);
    return false;
  }

  /** Whether `key` has used up its window, without counting anything. */
  isOver(key: string): boolean {
    return this.inWindow(key).length >= this.limit;
  }

  /** Count an attempt for `key` without answering (for doors that judge the attempt first). */
  record(key: string): void {
    const attempts = this.inWindow(key);
    attempts.push(this.now());
    this.touch(key, attempts);
  }

  /** Forget `key`'s attempts. */
  clear(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Uncount `key`'s latest attempt (for doors that count a try as it arrives and learn afterwards
   * that it should never have counted — a sign-in that succeeded).
   */
  forgive(key: string): void {
    const attempts = this.inWindow(key);
    attempts.pop();
    this.touch(key, attempts);
  }

  private inWindow(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    return (this.attempts.get(key) ?? []).filter((time) => time > cutoff);
  }

  /** Store `key`'s attempts as the most recently touched, evicting the oldest-touched key at the bound. */
  private touch(key: string, attempts: number[]): void {
    if (!this.attempts.has(key) && this.attempts.size >= this.maxKeys) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) {
        this.attempts.delete(oldest);
      }
    }
    this.attempts.delete(key);
    this.attempts.set(key, attempts);
  }
}
