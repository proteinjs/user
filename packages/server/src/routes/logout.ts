import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';

/**
 * Logout rides passport's own `request.logout` (functional for store-backed sessions since
 * passport 0.6, which added the callback form): it clears the user from the session and SAVES —
 * a replayed old session id is logged out even before the id rotates — then REGENERATES the
 * session id (fixation hygiene on the privilege change, mirroring login's rotation). The
 * regenerate destroys the old session row through the store (`DbSessionStore.destroy`), whose
 * row delete also disconnects the session's sockets (SocketIOSessionWatcher). The pre-0.6
 * manual compensation — calling `destroySession` and nulling `session.passport.user` by hand
 * because `request.logout` was broken — is retired with the workaround era that spawned it.
 */
export const logout: Route = {
  path: routes.logout.path,
  method: routes.logout.method,
  onRequest: async (request: any, response): Promise<void> => {
    await new Promise<void>((resolve, reject) =>
      request.logout((error: unknown) => (error ? reject(error) : resolve()))
    );
    response.redirect('/login');
  },
};
