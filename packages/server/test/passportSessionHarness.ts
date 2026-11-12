import passport from 'passport';

/** Session-lifecycle events in call order — the session-establishment contract under test. */
export type SessionEvent = 'regenerate' | 'login' | 'save';

export type PassportRequest = {
  /** Express-shaped request whose `login`/`logout` are REAL passport machinery. */
  request: any;
  /**
   * 'regenerate' / 'login' / 'save' in call order. The full contract of session establishment:
   * regenerate FIRST (a fresh session id on privilege change — session fixation), then the bind
   * of the account onto the fresh session, then save (the row must commit before the response).
   */
  events: SessionEvent[];
  /**
   * The session's data at each `save`, as a store would serialize it — one entry per save, in
   * order: what a session row would hold (the bound account, and anything else the session carries).
   */
  saved: Record<string, any>[];
};

/**
 * Builds a request whose `request.login` / `request.logout` are the GENUINE passport 0.6
 * machinery, wired through `authenticator.initialize()` — the same middleware the server runs —
 * over an express-session-shaped session mock.
 *
 * Why real passport and not a hand-mocked `login`: since passport 0.6 (the CVE-2022-25896
 * session-fixation fix), the regenerate and the commit-before-response save live INSIDE
 * `request.login` (SessionManager.logIn: regenerate → serializeUser → bind → save). A mocked
 * `login` would assert nothing about either — the door suites must drive the real owner to
 * prove the doors inherit the contract.
 *
 * serializeUser mirrors @proteinjs/server's identity pass-through (the session stores the
 * account email directly), instrumented to record the bind ('login') between 'regenerate' and
 * 'save'. The session mock replicates the one express-session behavior passport depends on:
 * `regenerate` REPLACES `request.session` with a fresh session (new id, no passport state), so
 * the bind provably lands on the post-regeneration session. Each `save` records the session's
 * data as JSON — what the store would write — so a suite reads what passport's save committed.
 */
export const createPassportRequest = async (extra: Record<string, unknown> = {}): Promise<PassportRequest> => {
  const events: SessionEvent[] = [];
  const saved: Record<string, any>[] = [];
  const authenticator = new passport.Passport();
  authenticator.serializeUser((user: unknown, done: (err: unknown, id?: unknown) => void) => {
    events.push('login');
    done(null, user);
  });

  const request: any = { ...extra };
  const makeSession = (): any => ({
    regenerate: (done: (err?: unknown) => void) => {
      events.push('regenerate');
      request.session = makeSession();
      done();
    },
    save: (done: (err?: unknown) => void) => {
      events.push('save');
      saved.push(JSON.parse(JSON.stringify(request.session)));
      done();
    },
  });
  request.session = makeSession();

  await new Promise<void>((resolve) => authenticator.initialize()(request, {} as never, () => resolve()));
  return { request, events, saved };
};
