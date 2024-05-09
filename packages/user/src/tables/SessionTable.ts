import { DateColumn, StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db';

export type Session = Record & {
    sessionId: string,
    session: string,
    expires: Date,
    userEmail: string
}

export class SessionTable extends Table<Session> {
    name = 'session';
    columns = withRecordColumns<Session>({
        sessionId: new StringColumn('session_id'),
        session: new StringColumn('serialized_session', {}, 4000),
        expires: new DateColumn('expires'),
        userEmail: new StringColumn('user_email'),
    });
};