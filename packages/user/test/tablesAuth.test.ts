import { tables } from '../src/tables/tables';
import { USER_PERMISSIONS } from '../src/permissions';

/**
 * The users/roles split lives in these table schemas — invariants worth pinning so a drive-by
 * edit cannot silently reopen a door:
 * - user: 'users' permission covers viewing/managing records, EXCEPT roles — the roles column is
 *   service-protected (single write path: the Roles service).
 * - role_grant_event: the audit trail is readable by 'roles' holders and has NO generic write
 *   door — an explicit auth block with no write grants is a lock, not an admin default.
 * - invite: 'users' holders read and delete; creating rides SignupService only.
 */

describe('user table auth shape', () => {
  it('gates every service door on the users permission', () => {
    expect(tables.User.auth?.service).toEqual({
      query: { permission: USER_PERMISSIONS.users },
      insert: { permission: USER_PERMISSIONS.users },
      update: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    });
  });

  it('service-protects the roles column (single write path: the Roles service)', () => {
    expect(tables.User.auth?.serviceProtectedColumns).toEqual(['roles']);
  });
});

describe('role_grant_event table auth shape', () => {
  it('is readable by roles holders and has no generic write door', () => {
    expect(tables.RoleGrantEvent.auth?.db).toEqual({ query: { permission: USER_PERMISSIONS.roles } });
    expect(tables.RoleGrantEvent.auth?.service).toEqual({ query: { permission: USER_PERMISSIONS.roles } });
  });
});

describe('invite table auth shape', () => {
  it('grants users-permission reads and deletes only; creation rides SignupService', () => {
    expect(tables.Invite.auth?.service).toEqual({
      query: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    });
  });
});
