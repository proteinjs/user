import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { tables, type User, type UserActivity } from '@proteinjs/user';

/**
 * Writes the LAST-ACTIVITY presence stamp (`user_activity`, one row per user — see
 * UserActivityTable's contract): "this human made an interactive request just now".
 *
 * The TRANSPORT keying lives at the call site — userCache.create runs once per session-cookie
 * request (wrapRoute's session-cache build) and only there, so seeded/background contexts
 * (runInUserScope sets session data directly) structurally never reach this class. What this
 * class owns is the ACCOUNT predicate: machine accounts (`isLoadedFromSource`) are refused —
 * their requests do arrive over real sessions (e.g. the error bridge's polling), but a machine
 * logging in is not a person being present.
 *
 * Write behavior mirrors DbSessionStore's touch: throttled per user (a presence fact consumed at
 * day grain needs no finer cadence, and an unthrottled stamp would put a write on EVERY request),
 * fail-open (a lost stamp is a few minutes of staleness, never a failed request — the returned
 * promise NEVER rejects), and race-tolerant (concurrent first stamps contend on the scope-unique
 * index; the loser's error is swallowed as debug).
 */
export class UserActivityStamp {
  /** Stamp at most this often per user — same cadence class as DbSessionStore.TOUCH_INTERVAL. */
  private static readonly STAMP_INTERVAL_MS = 1000 * 60 * 5;
  /** Process-wide: userCache is a plain object, so throttle state can't live per-instance. */
  private static lastStampMs = new Map<string, number>();

  private logger = new Logger({ name: this.constructor.name });

  /**
   * Record that `user` is present on an interactive request. Fire-and-forget safe: errors are
   * handled (and logged) here, so callers may `void` the returned promise.
   */
  recordInteractiveRequest(user: User): Promise<void> {
    if (!user.id || user.isLoadedFromSource === true) {
      return Promise.resolve();
    }
    const last = UserActivityStamp.lastStampMs.get(user.id) ?? 0;
    const now = Date.now();
    if (now - last < UserActivityStamp.STAMP_INTERVAL_MS) {
      return Promise.resolve();
    }
    UserActivityStamp.lastStampMs.set(user.id, now);
    if (UserActivityStamp.lastStampMs.size > 10000) {
      UserActivityStamp.lastStampMs.clear(); // bounded memory; worst case is one extra stamp per user
    }
    return this.upsert(user.id).catch((error) => {
      // Contention (a concurrent request stamped first, racing the scope-unique index) and real
      // failures land here alike; both are harmless to the request. Un-throttle so the next
      // request retries instead of waiting out a full interval on a stamp that never landed.
      UserActivityStamp.lastStampMs.delete(user.id);
      this.logger.error({ message: 'Failed to write user activity stamp', error });
    });
  }

  private async upsert(userId: string): Promise<void> {
    const db = getDbAsSystem();
    const existing = await db.get(tables.UserActivity, { scope: userId });
    if (existing) {
      await db.update(tables.UserActivity, { id: existing.id, lastActiveAt: moment() } as UserActivity);
    } else {
      await db.insert(tables.UserActivity, { scope: userId, lastActiveAt: moment() } as UserActivity);
    }
  }
}
