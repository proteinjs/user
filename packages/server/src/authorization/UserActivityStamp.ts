import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { guestUser, tables, type User, type UserActivity } from '@proteinjs/user';

/**
 * Writes the LAST-ACTIVITY presence stamp (`user_activity`, one row per user — see
 * UserActivityTable's contract): "this person gave a page input just now".
 *
 * The INPUT keying lives at the call site — the UserPresence service is the only caller, and
 * the page reports through it only from a real pointer / key / touch / wheel event. The
 * per-request session build (userCache.create) does NOT call this: it runs for every request
 * over a session cookie, and that transport is what an idle tab produces all day (polls, socket
 * re-joins on reconnect, the reload a deploy pushes) — presence keyed on it read every user as
 * "active today" (founder finding 2026-09-12). What this class owns is the ACCOUNT predicate:
 * the guest identity and machine accounts (`machine` — the one owner of "is this a machine",
 * founder ruling 2026-09-02) are refused, whatever door they arrive through.
 *
 * Write behavior mirrors DbSessionStore's touch: throttled per user (a presence fact consumed at
 * day grain needs no finer cadence, and the page already throttles its reports — this is the
 * belt), fail-open (a lost stamp is a few minutes of staleness, never a failed call — the
 * returned promise NEVER rejects), and race-tolerant (concurrent first stamps contend on the
 * scope-unique index; the loser's error is swallowed as debug).
 */
export class UserActivityStamp {
  /** Stamp at most this often per user — same cadence class as DbSessionStore.TOUCH_INTERVAL. */
  private static readonly STAMP_INTERVAL_MS = 1000 * 60 * 5;
  /** Process-wide: the throttle outlives any one service instance. */
  private static lastStampMs = new Map<string, number>();

  private logger = new Logger({ name: this.constructor.name });

  /**
   * Record that `user` gave a page human input. Fire-and-forget safe: errors are handled (and
   * logged) here, so callers may `void` the returned promise.
   */
  recordHumanInput(user: Pick<User, 'id' | 'machine'>): Promise<void> {
    if (!user.id || user.id === guestUser.id || user.machine === true) {
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
      // Contention (a concurrent report stamped first, racing the scope-unique index) and real
      // failures land here alike; both are harmless to the caller. Un-throttle so the next
      // report retries instead of waiting out a full interval on a stamp that never landed.
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
