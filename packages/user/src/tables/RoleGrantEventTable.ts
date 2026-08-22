import { StringColumn, Table, Record, withRecordColumns } from '@proteinjs/db';
import { USER_PERMISSIONS } from '../permissions';

/**
 * Audit row written by the Roles service for EVERY grant/revoke. The base `created` column is the
 * change timestamp. Rows are append-only: readable by 'roles' holders, written only by the Roles
 * service's system path — no generic door grants writes, so the trail cannot be edited from the
 * record surfaces.
 */
export type RoleGrantEvent = Record & {
  /** id of the user who made the change */
  actor: string;
  /** id of the user whose roles changed */
  target: string;
  role: string;
  action: 'grant' | 'revoke';
};

export class RoleGrantEventTable extends Table<RoleGrantEvent> {
  name = 'role_grant_event';
  auth: Table<RoleGrantEvent>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.roles },
    },
    service: {
      query: { permission: USER_PERMISSIONS.roles },
    },
  };
  columns: Table<RoleGrantEvent>['columns'] = withRecordColumns<RoleGrantEvent>({
    actor: new StringColumn('actor', {}, 36),
    target: new StringColumn('target', {}, 36),
    role: new StringColumn('role'),
    action: new StringColumn<'grant' | 'revoke'>('action', {}, 16),
  });
}
