export const routes: { [name: string]: { path: string; method: 'get' | 'post' | 'put' | 'patch' | 'delete' } } = {
  createUser: { path: '/user/create', method: 'post' },
  login: { path: '/user/login', method: 'post' },
  initiatePasswordReset: { path: '/user/initiate-password-reset', method: 'post' },
  executePasswordReset: { path: '/user/execute-password-reset', method: 'post' },
  logout: { path: '/user/logout', method: 'get' },
};
