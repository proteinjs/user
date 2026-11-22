export const routes: { [name: string]: { path: string; method: 'get' | 'post' | 'put' | 'patch' | 'delete' } } = {
  login: { path: '/user/login', method: 'post' },
  signup: { path: '/user/signup', method: 'post' },
  initiatePasswordReset: { path: '/user/initiate-password-reset', method: 'post' },
  executePasswordReset: { path: '/user/execute-password-reset', method: 'post' },
  validateResetToken: { path: '/user/validate-reset-token', method: 'get' },
  /**
   * Confirms an account's email address from the token in its mailed link (`?token=`), answering
   * `{ state: VerifyEmailState }` as JSON for the page that calls it (user-server
   * src/routes/verifyEmail.ts). The answer never names an address.
   */
  verifyEmail: { path: '/user/verify-email', method: 'get' },
  logout: { path: '/user/logout', method: 'get' },
};

/**
 * What `routes.verifyEmail` answers:
 * - 'confirmed': the address is confirmed and the link used up;
 * - 'logInFirst': where the product asks for the email confirmation, the link was opened outside its
 *   account's own session (nobody signed in, or another account): nothing is used up, and the same
 *   link confirms once the person has logged in to that account;
 * - 'expired': the link lapsed; a re-send makes a new one;
 * - 'invalid': unknown, malformed, already used, or replaced by a newer link.
 */
export type VerifyEmailState = 'confirmed' | 'logInFirst' | 'expired' | 'invalid';

/**
 * Avatar-photo URL contract (server route: user-server src/routes/avatar.ts): the path is stable
 * per user, so responses are cached hard (max-age=86400, immutable) and the `v` query param busts
 * the cache — pass the user's current `avatarFileId`, which changes on every photo update. Users
 * with an emoji avatar or no avatar answer 404 (clients render emoji/initials from the user
 * record; the route serves photos only).
 */
export const avatarRoute = {
  path: (userId: string, avatarFileId: string) =>
    `/avatar/${encodeURIComponent(userId)}?v=${encodeURIComponent(avatarFileId)}`,
  method: 'get' as const,
};

export const uiRoutes = {
  auth: {
    login: 'login',
    forgotPassword: 'login/forgot-password',
    passwordReset: 'login/password-reset',
    signup: 'signup',
  },
  account: {
    /**
     * The page a mailed verify-email link lands on, carrying `?token=`; it calls
     * `routes.verifyEmail` with the token and follows the state the route answers. Without a token it
     * is the one screen of a session whose account waits for that link (user-ui pages/ConfirmEmail).
     */
    verifyEmail: 'account/verify-email',
  },
};
