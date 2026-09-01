import { DateColumn, StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db';
import { USER_PERMISSIONS } from '../permissions';

export type Session = Record & {
  sessionId: string;
  session: string;
  expires: Date;
  userEmail: string;
};

/**
 * Readable by 'sessions' holders — its own permission because session rows carry auth material,
 * a different trust than 'users' people-management. Writes are system-written (DbSessionStore
 * rides getDbAsSystem, which bypasses TableAuth), so the explicit auth block grants no write
 * door — a lock even for break-glass admin, the role_grant_event pattern.
 */
export class SessionTable extends Table<Session> {
  name = 'session';
  auth: Table<Session>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.sessions },
    },
    service: {
      query: { permission: USER_PERMISSIONS.sessions },
    },
  };
  /**
   * The row scan: whose session, when it dies, which one. The serialized session blob (cookie
   * material) has no business in a row scan (founder admin review, v1.22) — it stays on the
   * record form for 'sessions' holders. The query-only doors above already mean the generic
   * surfaces derive no create/delete affordances here (rows are system-written).
   */
  ui: Table<Session>['ui'] = {
    recordTable: {
      columns: ['userEmail', 'expires', 'sessionId'],
    },
  };
  columns: Table<Session>['columns'] = withRecordColumns<Session>({
    sessionId: new StringColumn('session_id', { encrypted: false }),
    /**
     * Live serialized login material — encrypted (TRUST_AND_COMPLIANCE §1: a stolen row must
     * not be a stolen session). The session table has no scope column, so the deployment's
     * DbEncryptionConfig.resolveKeyOwner must name this table's key owner (n3xa keys all
     * session rows under one synthetic system owner; sessions are short-lived and are
     * deleted, not crypto-shredded, at account deletion).
     */
    session: new StringColumn('serialized_session', { encrypted: {} }, 4000),
    expires: new DateColumn('expires'),
    userEmail: new StringColumn('user_email', { encrypted: false }), // account identity — metadata by ruling
  });
}
