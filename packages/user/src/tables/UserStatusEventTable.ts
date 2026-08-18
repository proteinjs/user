import { StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db';
import { UserStatus } from './UserTable';

/**
 * Audit row written by the SetUserStatus service for EVERY status change. The base `created`
 * column is the change timestamp. Rows are append-only: readable by admins (the same scope as
 * the service that writes them), written only by the service's system path — no generic door
 * grants writes, so the trail cannot be edited from the record surfaces.
 */
export type UserStatusEvent = Record & {
  /** id of the user who made the change */
  actor: string;
  /** id of the user whose status changed */
  target: string;
  /** the standing the target was set to */
  status: UserStatus;
};

export class UserStatusEventTable extends Table<UserStatusEvent> {
  name = 'user_status_event';
  auth: Table<UserStatusEvent>['auth'] = {
    db: {
      query: ['admin'],
    },
    service: {
      query: ['admin'],
    },
  };
  columns = withRecordColumns<UserStatusEvent>({
    actor: new StringColumn('actor', {}, 36),
    target: new StringColumn('target', {}, 36),
    status: new StringColumn<UserStatus>('status', {}, 16),
  });
}
