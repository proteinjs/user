/**
 * The ONE owner of session establishment. Every door that mints a session — login, dev login,
 * signup auto-login — goes through here; no route calls `request.login` directly.
 *
 * The full contract — regenerate → bind → save, all committed before the caller responds — is
 * passport's own since 0.6 (its CVE-2022-25896 session-fixation fix). `request.login` runs
 * SessionManager.logIn: `session.regenerate` mints a FRESH session id on the privilege change
 * (an attacker-planted pre-auth sid never survives authentication), serializeUser binds the
 * account email onto the fresh session, and `session.save` commits the row before the callback
 * runs. The save half matters with a DB-backed session store: relying on save-at-response-end
 * races the client's follow-up navigation — the next request can read the session row before
 * the write commits and render the login page (observed live on /dev/login; the race class is
 * identical for every session-minting door).
 *
 * Deliberately NO regenerate or save around `request.login`: passport 0.6 offers no way to
 * disable its internal regenerate (`keepSessionInfo` only merges old session data back in after
 * regenerating), so a wrapper-level regenerate would mint two ids per login — one owner of the
 * lifecycle, and it is passport. SignupRoute.test.ts pins the exactly-once ordering against the
 * real passport machinery.
 *
 * COUPLED to the passport 0.6 upgrade in @proteinjs/server (which supplies the runtime passport
 * middleware): under passport 0.4, `request.login` neither regenerates nor saves — shipping this
 * package against a pre-0.6 @proteinjs/server would silently reopen both holes.
 *
 * `request` is typed loosely because passport augments the express request at runtime; the
 * routes in this package share that convention. A login failure (regenerate/serialize/save
 * error) rejects — a door must never answer success for a session that did not commit.
 */
export async function establishSession(request: any, email: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    request.login(email, (error: unknown) => (error ? reject(error) : resolve()))
  );
}
