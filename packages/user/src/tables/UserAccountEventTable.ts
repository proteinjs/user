import { StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db';
import { USER_PERMISSIONS } from '../permissions';

/**
 * Audit row written for EVERY change a user manager makes to another account's plain cells —
 * the base table's name, email and email-verified flag (the UserAccountAdmin service), and a
 * consumer's own account columns written through its own audited service (it names the column in
 * `field`). The base `created` column is the change timestamp. Rows are append-only: readable by
 * `users` holders (the same scope as the services that write them), written only by those
 * services' system path — no generic door grants writes, so the trail cannot be edited from the
 * record surfaces.
 *
 * Also written for every act on an account's passkeys (user-server `UserPasskeys`): `field` is
 * 'passkeys' and `value` the act — 'added' and 'removed' are a person's own acts, so `actor`
 * equals `target`; 'reset' is an admin's act on another person's passkeys, so `actor` is the
 * admin.
 *
 * The row carries no personal value: a name or an address written is not copied here (the user
 * row holds the current one, and an account purge must leave no address behind in a durable
 * table), nor is a passkey's name; `value` carries only a non-personal written value — a flag's
 * word, a consumer's phase, a passkey act.
 */
export type UserAccountEvent = Record & {
  /** id of the user who made the change */
  actor: string;
  /** id of the user whose cell changed */
  target: string;
  /** the cell that changed: 'name', 'email', 'emailVerified', a consumer's own column name, or 'passkeys' */
  field: string;
  /** the written value for a non-personal cell ('true' / 'false' for a flag; 'added', 'removed' or 'reset' for passkeys); null for name and email */
  value?: string | null;
};

export class UserAccountEventTable extends Table<UserAccountEvent> {
  name = 'user_account_event';
  /** The account audit trail keeps its rows: no caller deletes one (`Table.durable`) — and the record surfaces draw no delete act. */
  durable = true;
  auth: Table<UserAccountEvent>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
    },
  };
  columns: Table<UserAccountEvent>['columns'] = withRecordColumns<UserAccountEvent>({
    actor: new StringColumn('actor', {}, 36),
    target: new StringColumn('target', {}, 36),
    field: new StringColumn('field', {}, 64),
    value: new StringColumn('value', {}, 255),
  });
}
