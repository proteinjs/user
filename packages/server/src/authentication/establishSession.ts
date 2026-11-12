import { SecondFactorGate, SecondFactorRecord } from './SecondFactorGate';

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
 * disable its internal regenerate, so a wrapper-level regenerate would mint two ids per login —
 * one owner of the lifecycle, and it is passport. SignupRoute.test.ts pins the exactly-once
 * ordering against the real passport machinery.
 *
 * THE SECOND FACTOR'S RECORD rides passport's ONE save, never a second one. A door that proved a
 * second factor hands its record (`SecondFactorRecord`: the passkey that opened the session, or
 * the development door's mark); it is set on the session BEFORE the login, and the login is called
 * with passport's `keepSessionInfo`, which copies the previous session's properties onto the
 * regenerated one before its single save — so the record and the account are bound in one row, or
 * neither is: no session exists that binds the account and lacks the record it was opened with (a
 * second save could fail without the door knowing). A door that proved none hands none, and any
 * record the previous session carries is DELETED before the login — a session opened on a password
 * alone never inherits the record of the session that came before it in the same browser. After
 * the login the new session must carry exactly the record given, or the door refuses, in the
 * manner of the regenerate check below. What `keepSessionInfo` carries besides (it copies every
 * enumerable property of the previous session): the previous session's cookie object, which is the
 * same deployment's and whose expiry the session middleware rolls at the end of the response as
 * before; and nothing else from this package, which sets no other property on a request's session
 * — a consumer that sets one of its own will find it on the new session too.
 *
 * COUPLED to the passport 0.6 upgrade in @proteinjs/server (which supplies the runtime passport
 * middleware): under passport 0.4, `request.login` neither regenerates nor saves. That skew is
 * NOT silent here: the post-login guard below verifies the one observable trace of the contract —
 * express-session's regenerate always REPLACES `request.session` with a fresh Session — and
 * REFUSES (rejects) when the session object survived the login. A pre-0.6 runtime (a stale
 * @proteinjs/server < 3.5.1 checkout symlinked into a dev workspace, live-observed as
 * DEV_SMOKE_OVERNIGHT 2026-08-26 finding 7: /dev/login's redirected navigation raced the
 * deferred session write and landed on the login form) then fails loudly at the seam instead of
 * degrading into fixation-vulnerable, race-prone logins. The guard is a post-condition, not a
 * fallback — establishSession never does passport's regenerate/save itself.
 *
 * `request` is typed loosely because passport augments the express request at runtime; the
 * routes in this package share that convention. A login failure (regenerate/serialize/save
 * error) rejects — a door must never answer success for a session that did not commit.
 *
 * The address is bound LOWERCASED, as the account row holds it: the session row's `userEmail`
 * is what every by-account session kill matches on (`AccountSessions`, the deactivation watcher),
 * and a mixed-case sign-in bound as typed left sessions those kills could not find. The session
 * cache lowercases on every read regardless (userCache), so the bound value changes nothing else.
 */
export async function establishSession(
  request: any,
  email: string,
  options?: { secondFactor?: SecondFactorRecord }
): Promise<void> {
  const preLoginSession = request.session;
  const secondFactor = options?.secondFactor;
  if (preLoginSession) {
    if (secondFactor) {
      preLoginSession[SecondFactorGate.SESSION_KEY] = secondFactor;
    } else {
      delete preLoginSession[SecondFactorGate.SESSION_KEY];
    }
  }
  await new Promise<void>((resolve, reject) =>
    request.login(email.toLowerCase(), { keepSessionInfo: true }, (error: unknown) =>
      error ? reject(error) : resolve()
    )
  );
  if (request.session === preLoginSession) {
    throw new Error(
      'establishSession: request.login resolved without replacing request.session, so the runtime passport ' +
        'did not regenerate the session id (pre-0.6 shape — the runtime middleware comes from ' +
        '@proteinjs/server, which supplies passport 0.6 as of 3.5.1; check for a stale checkout or ' +
        'node_modules). Refusing to answer success: without regenerate → save-before-response, the ' +
        'post-login navigation races the session write (first hit lands unauthenticated) and session ' +
        'fixation (CVE-2022-25896) reopens.'
    );
  }
  const carried = request.session?.[SecondFactorGate.SESSION_KEY];
  if (JSON.stringify(carried) !== JSON.stringify(secondFactor)) {
    throw new Error(
      'establishSession: the session passport saved does not carry exactly the second-factor record this ' +
        'door gave (the runtime passport did not keep the session info across its regenerate — ' +
        '`keepSessionInfo`, passport 0.6). Refusing to answer success: the per-request check reads that ' +
        'record, and a session without the record it was opened with is not the session this door proved.'
    );
  }
}
