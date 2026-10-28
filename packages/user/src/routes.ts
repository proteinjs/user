export const routes: { [name: string]: { path: string; method: 'get' | 'post' | 'put' | 'patch' | 'delete' } } = {
  login: { path: '/user/login', method: 'post' },
  signup: { path: '/user/signup', method: 'post' },
  initiatePasswordReset: { path: '/user/initiate-password-reset', method: 'post' },
  executePasswordReset: { path: '/user/execute-password-reset', method: 'post' },
  validateResetToken: { path: '/user/validate-reset-token', method: 'get' },
  /**
   * Confirms an account's email address from the token in its mailed link (`?token=`), answering
   * `{ state }` as JSON for the page that calls it (user-server src/routes/verifyEmail.ts):
   * 'confirmed' (the address is now verified, the token spent), 'expired' (the link lapsed — ask
   * for a new one from the account page), or 'invalid' (unknown, malformed, or already spent).
   * The answer never names an address.
   */
  verifyEmail: { path: '/user/verify-email', method: 'get' },
  logout: { path: '/user/logout', method: 'get' },
};

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
     * `routes.verifyEmail` with the token and shows the state the route answers.
     */
    verifyEmail: 'account/verify-email',
  },
};
