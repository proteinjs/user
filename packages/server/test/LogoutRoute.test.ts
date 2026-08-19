import { logout } from '../src/routes/logout';
import { createPassportRequest } from './passportSessionHarness';

/**
 * `GET /user/logout` — logout through passport's own `request.logout` (functional for
 * store-backed sessions since passport 0.6, which added the callback form): clear the user and
 * SAVE (a replayed old session id is logged out even before the id rotates), then REGENERATE
 * the session id (fixation hygiene on the privilege change, mirroring login's rotation; the
 * regenerate is what tears down the old session row through the store). Driven over the REAL
 * passport machinery (passportSessionHarness); outcomes asserted: the surviving session carries
 * no user, the id was rotated, the request's user is cleared, and the client lands on /login.
 */
describe('logout route', () => {
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
});
