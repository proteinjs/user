import { Session } from '@proteinjs/server-api';
import { guestUser, UserAuth } from '@proteinjs/user';
import { Signup } from '../src/services/Signup';
import { productAsksForConfirmation } from './emailConfirmationHarness';

/**
 * Covers the SignupService auth gate. The invite-management methods are the door into
 * invite-only signup: `sendInvite` mints a valid signup token (as system), so if it is callable
 * by non-admins, ANYONE can invite themselves and bypass invite-only signup entirely.
 *
 * Regression under test: `canAccess` evaluated `UserAuth.hasRole('admin')` for
 * sendInvite/revokeInvite but DISCARDED the result and returned true unconditionally —
 * making both methods effectively public.
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed
 * (same pattern as @proteinjs/db's TableServiceAuth.test.ts).
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

const canAccess = (methodName: string) => {
  const signup = new Signup();
  return signup.serviceMetadata.auth.canAccess(methodName, []);
};

describe('Signup service auth', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  });

  it('denies sendInvite and revokeInvite to a caller without the users permission', () => {
    setUser([]);
    expect(canAccess('sendInvite')).toBe(false);
    expect(canAccess('revokeInvite')).toBe(false);
  });

  it('allows sendInvite and revokeInvite for an admin (break-glass)', () => {
    setUser(['admin']);
    expect(canAccess('sendInvite')).toBe(true);
    expect(canAccess('revokeInvite')).toBe(true);
  });

  it(`allows sendInvite and revokeInvite for a holder of the consumer's users-mapped role`, () => {
    setUser(['support']);
    setMapping({ users: ['support'] });
    expect(canAccess('sendInvite')).toBe(true);
    expect(canAccess('revokeInvite')).toBe(true);
  });

  it('keeps the pre-submit signup flow open (initializeSignup)', () => {
    // Account creation itself is no longer RPC-reachable — it moved to the signup ROUTE
    // (src/routes/signup.ts, covered by SignupRoute.test.ts), which establishes the session
    // in the same request (auto-login).
    setUser([]);
    expect(canAccess('initializeSignup')).toBe(true);
  });

  it('admits the re-send for a session that carries an address, never a visitor; the question on coming back is anyone to ask, and a visitor is answered nobody', async () => {
    const session = jest.spyOn(Session, 'getData');
    try {
      // A session whose account is held back until its address is confirmed: the request answers as nobody.
      (UserAuth as unknown as UserAuthInternals).userRepo = {
        getUser: () => ({ email: guestUser.email, roles: [] }),
      };
      session.mockReturnValue({ sessionId: 'a-session', user: 'someone@test.local', data: {} });
      expect(canAccess('resendEmailVerification')).toBe(true);
      expect(canAccess('emailConfirmationState')).toBe(true);

      // A visitor, as the waiting screen's request is once its session has ended somewhere else: no mail
      // is its to ask for, and asked whether it still waits it is answered nobody, so the screen can leave.
      session.mockReturnValue({ sessionId: undefined, user: undefined, data: {} });
      expect(canAccess('resendEmailVerification')).toBe(false);
      expect(canAccess('emailConfirmationState')).toBe(true);
      productAsksForConfirmation(true);
      expect(await new Signup().emailConfirmationState()).toEqual({ state: 'nobody' });
    } finally {
      productAsksForConfirmation(false);
      session.mockRestore();
    }
  });
});
