import { UserAuth } from '@proteinjs/user-auth';
import { TableAuth } from '@proteinjs/db';
import { tables } from '../src/tables/tables';
import { USER_PERMISSIONS } from '../src/permissions';

/**
 * The session table rides its own 'sessions' PERMISSION (a different trust than 'users'
 * people-management — session rows carry auth material): consumer-mapped sessions-role holders
 * can QUERY through both apis, while writes stay system-written — the explicit auth block grants
 * no write door, which locks insert/update/delete even for break-glass admin (the
 * role_grant_event pattern; DbSessionStore writes ride getDbAsSystem, which bypasses TableAuth).
 * The mapping deliberately names a role that is NOT the slug ('session-watch') to prove the
 * permission indirection.
 */

type UserAuthInternals = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  permissionRolesMapping?: { getRoles: (permission: string) => string[] | undefined };
};

const setUser = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'user@test.local', roles }),
  };
};

const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = {
    getRoles: (permission: string) => mapping[permission],
  };
};

describe('session table rides the sessions permission', () => {
  beforeEach(() => {
    setMapping({ [USER_PERMISSIONS.sessions]: ['session-watch'] });
  });

  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  });

  it('a consumer-mapped sessions-role holder can query through both apis', () => {
    setUser(['session-watch']);
    const auth = new TableAuth();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(tables.Session, api)).not.toThrow();
    }
  });

  it(`a 'users' holder is denied — seeing sessions is a different trust than managing people`, () => {
    setMapping({
      [USER_PERMISSIONS.sessions]: ['session-watch'],
      [USER_PERMISSIONS.users]: ['people-desk'],
    });
    setUser(['people-desk']);
    const auth = new TableAuth();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(tables.Session, api)).toThrow('User is not authorized to query table: session');
    }
  });

  it('writes stay system-written: no generic write door, even for break-glass admin', () => {
    const auth = new TableAuth();
    for (const roles of [['session-watch'], ['admin']]) {
      setUser(roles);
      for (const api of ['db', 'service'] as const) {
        expect(() => auth.canInsert(tables.Session, api)).toThrow(
          'User is not authorized to insert records into table: session'
        );
        expect(() => auth.canUpdate(tables.Session, api)).toThrow(
          'User is not authorized to update records in table: session'
        );
        expect(() => auth.canDelete(tables.Session, api)).toThrow(
          'User is not authorized to delete records from table: session'
        );
      }
    }
  });

  it('admin passes the query doors as break-glass', () => {
    setUser(['admin']);
    const auth = new TableAuth();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(tables.Session, api)).not.toThrow();
    }
  });
});
