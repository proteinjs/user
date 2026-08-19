/**
 * The ONE owner of session establishment. Every door that mints a session — login, dev login,
 * signup auto-login — goes through here; no route calls `request.login` directly.
 *
 * Three steps, in this order, all awaited before the caller responds:
 * 1. `request.session.regenerate` mints a FRESH session id on the privilege change. Our
 *    passport (0.4.x) does NOT regenerate inside `req.login` (that arrived in 0.6 as the
 *    session-fixation fix): without this, a session id planted pre-auth — e.g. a victim made
 *    to visit the site through an attacker-set cookie — would keep its id after the victim
 *    authenticates, leaving the attacker holding a logged-in session id. The pre-auth session
 *    is anonymous by construction (`saveUninitialized: false` — nothing is persisted before
 *    login), so regenerating loses nothing.
 * 2. `request.login` (passport) binds the account email to the fresh session.
 * 3. An explicit `request.session.save` commits the session row. With a DB-backed session
 *    store, relying on save-at-response-end races the client's follow-up navigation — the next
 *    request can read the session row before the write commits and render the login page
 *    (observed live on /dev/login; the race class is identical for every session-minting door).
 *
 * `request` is typed loosely because passport augments the express request at runtime; the
 * routes in this package share that convention.
 */
export async function establishSession(request: any, email: string): Promise<void> {
  await new Promise((resolve) => request.session.regenerate(resolve));
  await new Promise((resolve) => request.login(email, resolve));
  await new Promise((resolve) => request.session.save(resolve));
}
