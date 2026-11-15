import { routes } from '@proteinjs/user';
import { logout } from '../src/routes/logout';
import * as logoutRoutes from '../src/routes/logout';
import { createPassportRequest } from './passportSessionHarness';

/**
 * `POST /user/logout` — logout through passport's own `request.logout` (functional for
 * store-backed sessions since passport 0.6, which added the callback form): clear the user and
 * SAVE (a replayed old session id is logged out even before the id rotates), then REGENERATE
 * the session id (fixation hygiene on the privilege change, mirroring login's rotation; the
 * regenerate is what tears down the old session row through the store). Driven over the REAL
 * passport machinery (passportSessionHarness); outcomes asserted: the surviving session carries
 * no user, the id was rotated, the request's user is cleared, and the client lands on /login.
 */
describe('logout route', () => {
  it('is a POST — a GET reachable from any page by a link or an image tag could sign a person out (a cross-site request)', () => {
    expect(logout.method).toBe('post');
    expect(logout.path).toBe(routes.logout.path);
  });

  it('clears the user, saves, regenerates the session id, and redirects to /login', async () => {
    const { request, events } = await createPassportRequest();
    await new Promise<void>((resolve, reject) =>
      request.login('user@test.local', (error: unknown) => (error ? reject(error) : resolve()))
    );
    expect(request.session.passport.user).toBe('user@test.local'); // precondition: signed in
    events.length = 0; // watch only the logout lifecycle

    let redirect: string | undefined;
    const response: any = { redirect: (path: string) => (redirect = path) };
    await logout.onRequest(request as never, response as never);

    // Save-then-regenerate: the old session id is deauthenticated even if its cookie is
    // replayed, and the surviving session is a FRESH id with no user bound.
    expect(events).toEqual(['save', 'regenerate']);
    expect(request.session.passport?.user).toBeUndefined();
    expect(request.user).toBeNull();
    expect(redirect).toBe('/login');
  });

  it('a GET at the sign-out path is refused with 405 and ends nothing', async () => {
    // The route a GET at the path meets, found as the server matches it: by method and path. A page
    // built before sign-out became a POST still signs out with a GET; answered 200 by the app's
    // page, it would show the login screen while the session stood.
    const refusal = Object.values(logoutRoutes).find(
      (route) => route.method === 'get' && route.path === routes.logout.path
    );
    expect(refusal).toBeDefined();

    const { request } = await createPassportRequest();
    await new Promise<void>((resolve, reject) =>
      request.login('user@test.local', (error: unknown) => (error ? reject(error) : resolve()))
    );
    const session = request.session;

    const answer: { status?: number; headers: Record<string, string> } = { headers: {} };
    const response: any = {
      status: (code: number) => {
        answer.status = code;
        return response;
      },
      set: (name: string, value: string) => {
        answer.headers[name.toLowerCase()] = value;
        return response;
      },
      setHeader: (name: string, value: string) => response.set(name, value),
      end: () => response,
      send: () => response,
      redirect: (path: string) => response.status(302).set('Location', path),
    };
    await refusal!.onRequest(request as never, response as never);

    expect(answer.status).toBe(405);
    expect(answer.headers.allow).toBe('POST');
    // Ends nothing: the same session, its user still bound.
    expect(request.session).toBe(session);
    expect(request.session.passport.user).toBe('user@test.local');
    expect(request.user).toBe('user@test.local');
  });
});
