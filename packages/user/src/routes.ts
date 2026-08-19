export const routes: { [name: string]: { path: string; method: 'get' | 'post' | 'put' | 'patch' | 'delete' } } = {
  login: { path: '/user/login', method: 'post' },
  signup: { path: '/user/signup', method: 'post' },
  initiatePasswordReset: { path: '/user/initiate-password-reset', method: 'post' },
  executePasswordReset: { path: '/user/execute-password-reset', method: 'post' },
  validateResetToken: { path: '/user/validate-reset-token', method: 'get' },
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
};
