import { BooleanColumn, StringColumn, PasswordColumn, Table, Record, withRecordColumns } from '@proteinjs/db';

export type User = Record & {
    name: string,
    email: string,
    password: string,
    emailVerified: boolean,
    roles: string
}

export class UserTable extends Table<User> {
    name = 'user';
    columns = withRecordColumns<User>({
        name: new StringColumn('name'),
        email: new StringColumn('email', {}, 250),
        password: new PasswordColumn('password'),
        emailVerified: new BooleanColumn('email_verified'),
        roles: new StringColumn('roles'),
    });
};