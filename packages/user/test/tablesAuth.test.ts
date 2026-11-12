import { UserAuth } from '@proteinjs/user-auth';
import { TableAuth, TableServiceAuth } from '@proteinjs/db';
import { tables } from '../src/tables/tables';
import { USER_PERMISSIONS } from '../src/permissions';
import { isScopedTable, retainedOnAccountPurge } from '../src/ScopedRecord';

/**
 * The users/roles split lives in these table schemas — invariants worth pinning so a drive-by
 * edit cannot silently reopen a door:
 * - user: the 'users' permission READS records; the table has NO generic write door on EITHER
 *   api — every DbService insert, update and delete is refused, whoever asks (a 'users' holder
 *   could write another account's password cell raw through the generic RPC, and a hash-shaped
 *   value there verified as a legacy credential), and the db api grants no write either (server
 *   code writes the table as system, never as the calling user — a db write door would be a
 *   standing grant with no belt, since the protected list is enforced at the RPC gate alone).
 *   Every write is a named, audited service (UpdateUserInfo, UserAccountAdmin, Roles,
 *   SetUserStatus). The credential cells and the address are service-protected as the belt under
 *   the closed doors.
 * - role_grant_event: the audit trail is readable by 'roles' holders and has NO generic write
 *   door — an explicit auth block with no write grants is a lock, not an admin default.
 * - user_status_event: the standing audit trail is admin-read (the same scope as the
 *   SetUserStatus service that writes it) with NO generic write door.
 * - user_account_event: the account-cell audit trail is 'users'-read (the same scope as the
 *   UserAccountAdmin service that writes it) with NO generic write door.
 * - session: 'sessions' holders read (a different trust than 'users' — rows carry auth
 *   material); writes are system-written, so there is NO generic write door.
 * - invite: 'users' holders read and delete; creating rides SignupService only.
 * - user_passkey and auth_challenge: NO door on either api, the admin included — the public keys a
 *   second factor is verified against and the single-use challenges of its steps are the server's
 *   own, read and written as system.
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

const clearUser = () => {
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
};

describe('user table auth shape', () => {
  it('reads under the users permission and declares NO generic write door on the service api', () => {
    expect(tables.User.auth?.service).toEqual({
      query: { permission: USER_PERMISSIONS.users },
    });
    expect(tables.User.auth?.service?.insert).toBeUndefined();
    expect(tables.User.auth?.service?.update).toBeUndefined();
    expect(tables.User.auth?.service?.delete).toBeUndefined();
  });

  it(`declares NO generic write door on the db api either — the session and audit tables' shape (server code
      writes the table as system; a db write door would be a standing grant with no belt)`, () => {
    expect(tables.User.auth?.db).toEqual({
      query: { permission: USER_PERMISSIONS.users },
    });
    expect(tables.User.auth?.db?.insert).toBeUndefined();
    expect(tables.User.auth?.db?.update).toBeUndefined();
    expect(tables.User.auth?.db?.delete).toBeUndefined();
  });

  it(`service-protects roles and status (single write paths: the Roles and SetUserStatus
      services), the deletion-machinery datetimes (written only by the server-side deletion
      flow), machine-account ownership (written only by the boot sync), and — the belt under
      the closed doors — the credential cells and the address`, () => {
    expect(tables.User.auth?.serviceProtectedColumns).toEqual([
      'roles',
      'status',
      'deleteRequestedAt',
      'purgeAfter',
      'isLoadedFromSource',
      'password',
      'passwordResetToken',
      'passwordResetTokenExpiration',
      'emailVerificationToken',
      'emailVerificationTokenExpiration',
      'email',
    ]);
  });
});

/**
 * The outcome at the RPC gate (`TableServiceAuth`, what `DbService` runs before any operation):
 * a 'users' holder reads the table and is refused every write — the update that carried another
 * account's password cell (the take-over the open door allowed), an insert, a delete — and so is
 * the break-glass admin: an undeclared door is closed to everyone, not admin-default.
 */
describe('the user table has no generic write door at the RPC gate', () => {
  const gate = () => new TableServiceAuth();
  const otherAccount = { id: 'other-account', password: 'a'.repeat(64) };

  beforeEach(() => {
    setMapping({ [USER_PERMISSIONS.users]: ['people-desk'] });
  });

  afterEach(clearUser);

  it(`a 'users' holder queries the table`, () => {
    setUser(['people-desk']);
    expect(gate().canAccess('query', [tables.User, { id: 'other-account' }])).toBe(true);
  });

  it(`a 'users' holder's update carrying another account's password cell is refused`, () => {
    setUser(['people-desk']);
    expect(() => gate().canAccess('update', [tables.User, otherAccount])).toThrow(
      'User is not authorized to update records in table: user'
    );
  });

  it(`a 'users' holder's update of a plain cell is refused too — the door is closed, not filtered`, () => {
    setUser(['people-desk']);
    expect(() => gate().canAccess('update', [tables.User, { id: 'other-account', name: 'Renamed' }])).toThrow(
      'User is not authorized to update records in table: user'
    );
  });

  it(`a 'users' holder's insert and delete are refused`, () => {
    setUser(['people-desk']);
    expect(() =>
      gate().canAccess('insert', [tables.User, { name: 'New', email: 'new@test.local', password: 'x', roles: [] }])
    ).toThrow('User is not authorized to insert records into table: user');
    expect(() => gate().canAccess('delete', [tables.User, { id: 'other-account' }])).toThrow(
      'User is not authorized to delete records from table: user'
    );
  });

  it('the break-glass admin is refused the same writes — an undeclared door is closed to everyone', () => {
    setUser(['admin']);
    expect(() => gate().canAccess('update', [tables.User, otherAccount])).toThrow(
      'User is not authorized to update records in table: user'
    );
    expect(() => gate().canAccess('delete', [tables.User, { id: 'other-account' }])).toThrow(
      'User is not authorized to delete records from table: user'
    );
  });

  /**
   * The db api's own gate (`TableAuth`, what the inner Db runs for a non-system caller): the same
   * writes are refused there too, for the 'users' holder and for the admin — so a write cannot
   * reach the row through any door, whichever api a caller holds; the read stays open to 'users'.
   */
  it(`the db api refuses the same writes to a 'users' holder and to the admin — no door on either api`, () => {
    const dbGate = new TableAuth();
    for (const roles of [['people-desk'], ['admin']]) {
      setUser(roles);
      expect(() => dbGate.canQuery(tables.User, 'db')).not.toThrow();
      expect(() => dbGate.canInsert(tables.User, 'db')).toThrow(
        'User is not authorized to insert records into table: user'
      );
      expect(() => dbGate.canUpdate(tables.User, 'db')).toThrow(
        'User is not authorized to update records in table: user'
      );
      expect(() => dbGate.canDelete(tables.User, 'db')).toThrow(
        'User is not authorized to delete records from table: user'
      );
    }
  });
});

describe('role_grant_event table auth shape', () => {
  it('is readable by roles holders and has no generic write door', () => {
    expect(tables.RoleGrantEvent.auth?.db).toEqual({ query: { permission: USER_PERMISSIONS.roles } });
    expect(tables.RoleGrantEvent.auth?.service).toEqual({ query: { permission: USER_PERMISSIONS.roles } });
  });
});

describe('user_status_event table auth shape', () => {
  it('is admin-read only and has no generic write door', () => {
    expect(tables.UserStatusEvent.auth?.db).toEqual({ query: ['admin'] });
    expect(tables.UserStatusEvent.auth?.service).toEqual({ query: ['admin'] });
  });
});

describe('user_account_event table auth shape', () => {
  it('is readable by users holders (the scope of the service that writes it) and has no generic write door', () => {
    expect(tables.UserAccountEvent.auth?.db).toEqual({ query: { permission: USER_PERMISSIONS.users } });
    expect(tables.UserAccountEvent.auth?.service).toEqual({ query: { permission: USER_PERMISSIONS.users } });
  });
});

describe('session table auth shape', () => {
  it('is readable by sessions holders and has no generic write door (writes are system-written)', () => {
    expect(tables.Session.auth?.db).toEqual({ query: { permission: USER_PERMISSIONS.sessions } });
    expect(tables.Session.auth?.service).toEqual({ query: { permission: USER_PERMISSIONS.sessions } });
  });
});

/**
 * The passkey and sign-in challenge tables, at both gates: the RPC gate (`TableServiceAuth`, every
 * DbService method) and the db api's own (`TableAuth`). `query: []` admits nobody, the break-glass
 * admin included, and a declared block's other operations stay closed — so no caller reads a
 * public key or a challenge's hash, or writes either, through a generic door. Passkeys belong to
 * the account: the table is scoped and purges with it.
 */
describe('the passkey and sign-in challenge tables have no door on either api', () => {
  const named = (name: string) => Object.values(tables).find((table) => table.name === name);
  const serviceMethods = ['get', 'query', 'getRowCount', 'insert', 'update', 'updatePreserving', 'delete'];

  afterEach(clearUser);

  it(`neither table has a door on either api: the admin's query, insert, update and delete are refused at the gate; user_passkey is a scoped table that is not retained on account purge`, () => {
    setUser(['admin']);
    const passkeys = named('user_passkey');
    const challenges = named('auth_challenge');
    expect(passkeys).toBeDefined();
    expect(challenges).toBeDefined();

    for (const table of [passkeys!, challenges!]) {
      for (const method of serviceMethods) {
        expect(() => new TableServiceAuth().canAccess(method, [table, { id: 'row-1' }])).toThrow(
          `User is not authorized to`
        );
      }
      for (const operation of ['query', 'insert', 'update', 'delete'] as const) {
        for (const api of ['db', 'service'] as const) {
          expect(new TableAuth().canPerform(table, operation, api)).toBe(false);
        }
      }
    }

    expect(isScopedTable(passkeys!)).toBe(true);
    expect(retainedOnAccountPurge(passkeys!)).toBe(false);
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

  /**
   * The create act is a DECLARED list action, not an insert door (the Invites table lost its `+`
   * when the record surfaces started deriving affordances from the doors — creation rides
   * SignupService, so no insert door exists, and the form's own Send act became unreachable from
   * the table). The action's door names the identity the send act serves; the generic insert stays
   * closed on both apis, and no create-specific door exists anywhere else.
   */
  it('declares the create act for users holders while the generic insert stays closed', () => {
    const create = tables.Invite.ui?.recordTable?.actions?.find((action) => action.kind === 'create');
    expect(create?.door).toEqual({ permission: USER_PERMISSIONS.users });
    expect(tables.Invite.auth?.service?.insert).toBeUndefined();
    expect(tables.Invite.auth?.db?.insert).toBeUndefined();
    expect(tables.Invite.auth?.ui).toBeUndefined();
  });
});
