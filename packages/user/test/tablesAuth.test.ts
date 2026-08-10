import { tables } from '../src/tables/tables';
import { USER_PERMISSIONS } from '../src/permissions';

/**
 * The users/roles split lives in these table schemas — invariants worth pinning so a drive-by
 * edit cannot silently reopen a door:
 * - user: 'users' permission covers viewing/managing records, EXCEPT roles — the roles column is
 *   service-protected (single write path: the Roles service).
 * - role_grant_event: the audit trail is readable by 'roles' holders and has NO generic write
 *   door — an explicit auth block with no write grants is a lock, not an admin default.
 * - session: 'sessions' holders read (a different trust than 'users' — rows carry auth
 *   material); writes are system-written, so there is NO generic write door.
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

  it(`gates every db door on the users permission too — DbService's inner Db re-checks the db api
      as the calling user, so a service-only shape leaves the record surfaces admin-locked
      (live-observed: a users-holder's Users table denied)`, () => {
    expect(tables.User.auth?.db).toEqual({
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

describe('session table auth shape', () => {
  it('is readable by sessions holders and has no generic write door (writes are system-written)', () => {
    expect(tables.Session.auth?.db).toEqual({ query: { permission: USER_PERMISSIONS.sessions } });
    expect(tables.Session.auth?.service).toEqual({ query: { permission: USER_PERMISSIONS.sessions } });
  });
});

describe('invite table auth shape', () => {
  it('grants users-permission reads and deletes only; creation rides SignupService', () => {
    expect(tables.Invite.auth?.service).toEqual({
      query: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    });
    // Mirrored on the db api — the record surfaces' inner Db re-checks it (see the user table).
    expect(tables.Invite.auth?.db).toEqual({
      query: { permission: USER_PERMISSIONS.users },
      delete: { permission: USER_PERMISSIONS.users },
    });
  });
});
