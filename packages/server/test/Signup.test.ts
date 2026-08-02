import { UserAuth } from '@proteinjs/user';
import { Signup } from '../src/services/Signup';

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

type UserAuthInternals = { userRepo?: { getUser: () => { email: string; roles: string[] } } };

const setUser = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'user@test.local', roles }),
  };
};

const canAccess = (methodName: string) => {
  const signup = new Signup();
  return signup.serviceMetadata.auth.canAccess(methodName, []);
};

describe('Signup service auth', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  it('denies sendInvite and revokeInvite to a non-admin', () => {
    setUser([]);
    expect(canAccess('sendInvite')).toBe(false);
    expect(canAccess('revokeInvite')).toBe(false);
  });

  it('allows sendInvite and revokeInvite for an admin', () => {
    setUser(['admin']);
    expect(canAccess('sendInvite')).toBe(true);
    expect(canAccess('revokeInvite')).toBe(true);
  });

  it('keeps the signup flow itself open (createUser / initializeSignup)', () => {
    setUser([]);
    expect(canAccess('createUser')).toBe(true);
    expect(canAccess('initializeSignup')).toBe(true);
  });
});
