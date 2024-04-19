export const routes: {[name: string]: { path: string, method: 'get'|'post'|'put'|'patch'|'delete' }} = {
  createUser: { path: '/user/create', method: 'post' },
  login: { path: '/user/login', method: 'post' },
  logout: { path: '/user/logout', method: 'get' },
}