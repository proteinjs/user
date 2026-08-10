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
  columns = withRecordColumns<Session>({
    sessionId: new StringColumn('session_id'),
    session: new StringColumn('serialized_session', {}, 4000),
    expires: new DateColumn('expires'),
    userEmail: new StringColumn('user_email'),
  });
}
