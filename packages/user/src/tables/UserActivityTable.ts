import { DateTimeColumn, Table } from '@proteinjs/db';
import { Moment } from 'moment';
import { ScopedRecord, createScopedIndex, withScopedRecordColumns } from '../ScopedRecord';
import { USER_PERMISSIONS } from '../permissions';

/**
 * LAST ACTIVITY (human presence): the most recent request a signed-in human made through a live
 * interactive session — one row per user (`scope` = their id, unique). This is the ONE owner of
 * "when was this person last here"; admin surfaces that speak "last active" read it.
 *
 * The stamp is keyed on TRANSPORT, not on what the work was: only requests that arrive through
 * the session-cookie request path write it (user-server's UserActivityStamp, invoked from the
 * per-request session-cache build). Machinery acting on a user's behalf — routine ticks,
 * watchers, background flow runs, delegated machine-account work — executes under seeded
 * session contexts (`runInUserScope`) that never traverse that path, so no background actor can
 * ever read as presence; machine accounts are refused by the stamp even though their requests do
 * arrive over real sessions. Deliberately NOT derived from the usage ledger: spend measures
 * model work (which routines rack up all day), not the human being present.
 *
 * Reads are people-management trust ('users', the Users-page permission); writes are
 * system-written only (no service/db write door — the stamp rides the system path), so the
 * record surfaces cannot fabricate presence. Scoped with no retain policy: presence rows purge
 * with the account (the privacy-safe default for a behavioral fact).
 */
export type UserActivity = ScopedRecord & {
  /** When the user's most recent interactive request arrived (stamp cadence is throttled — see UserActivityStamp). */
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
