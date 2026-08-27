import http from 'http';
import { AddressInfo } from 'net';
import expressSession, { Store } from 'express-session';
import passport from 'passport';
import { devLogin } from '../src/routes/devLogin';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * DEV_SMOKE_OVERNIGHT (2026-08-26) finding 7: a browser holding a STALE session cookie (a sid
 * absent from the store — prior server generation, swept row, or reseeded dev db) hits
 * `GET /dev/login`, gets the 302, and lands on the LOGIN FORM; the second hit lands home.
 *
 * The mechanism is write-ordering at the session-establishment seam: a browser follows a redirect
 * the moment RESPONSE HEADERS arrive — it never waits for the body. So the session row for the
 * sid named by the 302's Set-Cookie must be COMMITTED to the store before those headers flush.
 * passport 0.6's `request.login` guarantees exactly that (regenerate → bind → save, committed
 * before the login callback — see establishSession); under a pre-0.6 passport runtime the save
 * is deferred to express-session's end-of-response proxy, whose split-response write flushes the
 * 302's headers BEFORE the store write commits — the redirected navigation races the commit and
 * loses, reads no session, and the SPA routes to /login.
 *
 * This suite drives the REAL stack a browser meets — express-session 1.17.1 (the exact
 * @proteinjs/server configureSession options and dev cookie-name shape) + real passport +
 * the devLogin route — against a store with honest commit latency, and asserts the contract
 * from the client's side: follow the 302 the instant headers arrive, carrying exactly the
 * cookies the response set, and the follow-up MUST read as authenticated on the FIRST pass.
 */

const SESSION_COOKIE_NAME = 'n3xa.sid.9876'; // dev cookie-name shape: n3xa.sid.${SERVER_PORT}
const SESSION_SECRET = 'dev-first-hit-test-secret';
const ENV_EMAIL = 'dev@test.local';
/** Store commit latency. Generous so a pre-0.6 runtime (write racing the redirect) loses the
 *  race DETERMINISTICALLY; under the passport 0.6 contract the row commits before the redirect
 *  is even issued, so green never depends on this number. */
const COMMIT_LATENCY_MS = 150;
const READ_LATENCY_MS = 5;

/**
 * In-memory session store with DbSessionStore's contract: callbacks fire only after the
 * operation commits, and commits take real time (Spanner in dev). Rows are inspectable so the
 * test can assert store truth directly and clear it to model a next server generation.
 */
class CommitLatencySessionStore extends Store {
  readonly rows = new Map<string, string>();

  get = (sessionId: string, cb: (error: unknown, session?: Express.SessionData | null) => void) => {
    const timer = setTimeout(() => {
      const row = this.rows.get(sessionId);
      cb(null, row ? JSON.parse(row) : undefined);
    }, READ_LATENCY_MS);
    timer.unref();
  };

  set = (sessionId: string, session: Express.SessionData, cb?: (error?: unknown) => void) => {
    const timer = setTimeout(() => {
      this.rows.set(sessionId, JSON.stringify(session));
      if (cb) {
        cb();
      }
    }, COMMIT_LATENCY_MS);
    timer.unref();
  };

  destroy = (sessionId: string, cb?: (error?: unknown) => void) => {
    const timer = setTimeout(() => {
      this.rows.delete(sessionId);
      if (cb) {
        cb();
      }
    }, READ_LATENCY_MS);
    timer.unref();
  };
}

type Middleware = (req: unknown, res: unknown, next: (error?: unknown) => void) => void;

type ClientResponse = { statusCode?: number; headers: http.IncomingHttpHeaders; body?: string };

describe('devLogin first hit through the real session middleware stack', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
  };
  const store = new CommitLatencySessionStore();
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    await testEnv.beforeAll();
    await testEnv.createUser({ name: 'Dev Default', email: ENV_EMAIL });
    server = createServerWithRealSessionStack(store);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await testEnv.afterAll();
  });

  beforeEach(() => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = ENV_EMAIL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('stale-cookie first hit: following the 302 on HEADERS reads as authenticated, first pass', async () => {
    // A genuinely stale cookie: minted by a prior hit (valid signature, real sid), then the
    // store loses the row — a prior server generation against a reseeded/swept dev db.
    const priorHit = await request(port, '/dev/login', { waitForBody: true });
    const staleCookie = sessionCookiePair(priorHit);
    store.rows.clear();

    // First hit with the stale cookie. Resolve on response HEADERS — the moment a browser
    // starts the redirected navigation — never on body completion.
    const firstHit = await request(port, '/dev/login', { cookie: staleCookie });
    expect(firstHit.statusCode).toBe(302);
    expect(firstHit.headers.location).toBe('/');

    // The 302 must mint a fresh sid (the stale sid must not be resurrected)...
    const followUpCookie = sessionCookiePair(firstHit);
    expect(sidOf(followUpCookie)).not.toBe(sidOf(staleCookie));

    // ...whose session row is ALREADY COMMITTED: the immediate follow-up navigation, carrying
    // exactly the cookies the response set, reads as authenticated on the FIRST pass.
    const followUp = await request(port, '/whoami', { cookie: followUpCookie, waitForBody: true });
    expect(JSON.parse(followUp.body!)).toEqual({ user: ENV_EMAIL });
  });

  it('cookieless first hit: same first-pass guarantee for a fresh browser', async () => {
    store.rows.clear();

    const firstHit = await request(port, '/dev/login');
    expect(firstHit.statusCode).toBe(302);

    const followUp = await request(port, '/whoami', { cookie: sessionCookiePair(firstHit), waitForBody: true });
    expect(JSON.parse(followUp.body!)).toEqual({ user: ENV_EMAIL });
  });
});

/**
 * The real middleware stack a request traverses in front of the route — express-session with
 * @proteinjs/server configureSession's exact options (resave: false, saveUninitialized: false,
 * rolling: true, the dev port-scoped cookie name) + passport initialize/session with the
 * identity (de)serialization @proteinjs/server registers — on a raw node http server, so
 * header-flush timing is the genuine article.
 */
function createServerWithRealSessionStack(store: Store): http.Server {
  const sixtyDays = 1000 * 60 * 60 * 24 * 60;
  const sessionMiddleware = expressSession({
    name: SESSION_COOKIE_NAME,
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: sixtyDays },
    rolling: true,
  });
  const authenticator = new passport.Passport();
  authenticator.serializeUser((user: unknown, done: (err: unknown, id?: unknown) => void) => done(null, user));
  authenticator.deserializeUser((id: unknown, done: (err: unknown, user?: unknown) => void) => done(null, id));
  const middleware: Middleware[] = [
    sessionMiddleware as unknown as Middleware,
    authenticator.initialize() as unknown as Middleware,
    authenticator.session() as unknown as Middleware,
  ];

  return http.createServer((req, res) => {
    runMiddleware(middleware, req, res, (error?: unknown) => {
      if (error) {
        res.statusCode = 500;
        res.end(String(error));
        return;
      }
      void dispatch(req, res);
    });
  });
}

function runMiddleware(
  middleware: Middleware[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
  done: (error?: unknown) => void
) {
  const next = (index: number) => (error?: unknown) => {
    if (error || index >= middleware.length) {
      done(error);
      return;
    }
    middleware[index](req, res, next(index + 1));
  };
  next(0)();
}

async function dispatch(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/dev/login') {
    const request = req as never as Record<string, unknown>;
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (query[key] = value));
    request.query = query;
    try {
      await devLogin.onRequest(req as never, expressResponseShim(res) as never);
    } catch (error) {
      // Mirrors @proteinjs/server's wrapRoute: a route throw is caught and logged, never a
      // hung response. (There it falls through to the star route; here we end with 500.)
      console.error(error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    }
    return;
  }
  if (url.pathname === '/whoami') {
    // The session-derived signal the SPA lands on: authenticated → home, none → login form.
    const session = (req as never as { session?: { passport?: { user?: string } } }).session;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ user: session?.passport?.user ?? null }));
    return;
  }
  res.statusCode = 404;
  res.end();
}

/** The express response surface devLogin touches, over the RAW response object — so
 *  express-session's proxied `res.end` (the commit point under test) is the one that runs. */
function expressResponseShim(res: http.ServerResponse) {
  const shim = {
    status(code: number) {
      res.statusCode = code;
      return shim;
    },
    send(body?: unknown) {
      res.end(body === undefined ? undefined : String(body));
    },
    redirect(path: string) {
      const body = `Found. Redirecting to ${path}`;
      res.statusCode = 302;
      res.setHeader('Location', path);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    },
  };
  return shim;
}

/**
 * GET `path`. By default resolves the moment response HEADERS arrive (browser-following-a-
 * redirect semantics — the body may still be in flight and its socket is left to drain);
 * `waitForBody` resolves after the full body, which with express-session's end proxy also
 * means the response's session write has committed.
 */
function request(
  port: number,
  path: string,
  options: { cookie?: string; waitForBody?: boolean } = {}
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = http.get(
      { port, path, headers: options.cookie ? { cookie: options.cookie } : {}, agent: false },
      (res) => {
        if (!options.waitForBody) {
          resolve({ statusCode: res.statusCode, headers: res.headers });
          res.resume();
          return;
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    clientRequest.on('error', reject);
  });
}

/** The `name=value` pair of the response's session Set-Cookie — what the browser sends back. */
function sessionCookiePair(response: ClientResponse): string {
  const setCookies = response.headers['set-cookie'] ?? [];
  const sessionCookie = setCookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionCookie) {
    throw new Error(`response set no ${SESSION_COOKIE_NAME} cookie (Set-Cookie: ${JSON.stringify(setCookies)})`);
  }
  return sessionCookie.split(';')[0];
}

/** The raw sid inside a signed session cookie pair (`name=s%3A<sid>.<signature>`). */
function sidOf(cookiePair: string): string {
  const value = decodeURIComponent(cookiePair.slice(cookiePair.indexOf('=') + 1));
  return value.startsWith('s:') ? value.slice(2, value.indexOf('.')) : value;
}
