/**
 * The ONE owner of session establishment. Every door that mints a session — login, dev login,
 * signup auto-login — goes through here; no route calls `request.login` directly.
 *
 * Two steps, both awaited before the caller responds:
 * 1. `request.login` (passport) binds the account email to the request's session.
 * 2. An explicit `request.session.save` commits the session row. With a DB-backed session
 *    store, relying on save-at-response-end races the client's follow-up navigation — the next
 *    request can read the session row before the write commits and render the login page
 *    (observed live on /dev/login; the race class is identical for every session-minting door).
 *
 * `request` is typed loosely because passport augments the express request at runtime; the
 * routes in this package share that convention.
 */
export async function establishSession(request: any, email: string): Promise<void> {
  await new Promise((resolve) => request.login(email, resolve));
  await new Promise((resolve) => request.session.save(resolve));
}
