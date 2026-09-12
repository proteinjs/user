import { DateTimeColumn, Table } from '@proteinjs/db';
import { Moment } from 'moment';
import { ScopedRecord, createScopedIndex, withScopedRecordColumns } from '../ScopedRecord';
import { USER_PERMISSIONS } from '../permissions';

/**
 * LAST ACTIVITY (human presence): the most recent HUMAN INPUT a signed-in person gave a page —
 * one row per user (`scope` = their id, unique). This is the ONE owner of "when was this person
 * last here"; admin surfaces that speak "last active" read it.
 *
 * The stamp is keyed on INPUT, not on transport: the page reports a person's pointer / key /
 * touch / wheel event through `UserPresenceService.recordPresence` (user-ui's
 * UserPresenceReporter, throttled per page), and user-server's UserActivityStamp writes the row
 * from that door only. Transport was the previous key (the per-request session-cache build) and
 * it over-counted (every user read as "last active today"): an open tab polls, a socket re-joins
 * its rooms on every reconnect, a deploy reloads every idle tab — all of it arrives over a live
 * session with nobody there. Machinery acting on a user's behalf (scheduled jobs, watchers,
 * background runs under seeded contexts) has no page to report from, so it structurally cannot
 * stamp; machine accounts are refused by the stamp. Deliberately NOT derived from any usage or
 * spend ledger: spend measures machine work (which background jobs rack up all day), not the
 * human being present.
 *
 * Reads are people-management trust ('users', the Users-page permission); writes are
 * system-written only (no service/db write door onto the row — the stamp rides the system
 * path), so the record surfaces cannot fabricate presence. Scoped with no retain policy:
 * presence rows purge with the account (the privacy-safe default for a behavioral fact).
 */
export type UserActivity = ScopedRecord & {
  /** When the user's most recent human input was reported (stamp cadence is throttled — see UserActivityStamp). */
  lastActiveAt: Moment;
};

export class UserActivityTable extends Table<UserActivity> {
  name = 'user_activity';
  auth: Table<UserActivity>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
    },
  };
  indexes = [createScopedIndex<UserActivity>({ columns: [], name: 'user_activity_scope_unique', unique: true })];
  columns: Table<UserActivity>['columns'] = withScopedRecordColumns<UserActivity>({
    lastActiveAt: new DateTimeColumn('last_active_at'),
  });
}
