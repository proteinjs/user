import { DateColumn, StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db';

export type Session = Record & {
  sessionId: string;
  session: string;
  expires: Date;
  userEmail: string;
};

export class SessionTable extends Table<Session> {
  name = 'session';
  columns = withRecordColumns<Session>({
    sessionId: new StringColumn('session_id'),
    // Serialized machine state (up to 4000 chars) — unreadable noise in generic UI (record
    // table/form). Hidden so the admin Sessions table reads as who/when, not blobs.
    session: new StringColumn('serialized_session', { ui: { hidden: true } }, 4000),
    expires: new DateColumn('expires'),
    userEmail: new StringColumn('user_email'),
  });
}
