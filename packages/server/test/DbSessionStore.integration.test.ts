import http from 'http';
import { AddressInfo } from 'net';
import expressSession from 'express-session';
import passport from 'passport';

/**
 * The session store (`DbSessionStore`) over the Spanner emulator, behind the session machinery a browser
 * meets: express-session 1.17.1 with the server library's options (@proteinjs/server configureSession),
 * real passport, and the library's own log-in and sign-up routes. Outcomes only: which sessions have a
 * row, and who the next request of a cookie is.
 *
 * - A session's row is written once: a session that is ended while one of its requests is at work stays
 *   ended; a first write that is aborted is made again by the same save; and a session whose row cannot
 *   be written as it is made is ended in that request.
 * - A session made on a password stands only while the account holds that password (`PasswordSession`),
 *   in each order of a sign-up that starts a waiting account over beside a sign-up or a log-in that is
 *   still at work; and a session whose account cannot be read back is ended.
 *
 * The email transport is stubbed at the module boundary (the SignupRoute.test.ts pattern); the db is real.
 */

const sendEmail = jest.fn();

jest.mock('@proteinjs/email-server', () => ({
  EmailSender: jest.fn().mockImplementation(() => ({ sendEmail })),
  getDefaultInviteEmailConfigFactory: () => ({
    getConfig: () => ({ getEmailContent: () => ({ text: 'invite', html: '<p>invite</p>' }) }),
  }),
  getDefaultSignupConfirmationEmailConfigFactory: () => ({
    getConfig: () => ({
      getNewUserEmailContent: () => ({ text: 'welcome', html: '<p>welcome</p>' }),
      getExistingUserEmailContent: () => ({ text: 'exists', html: '<p>exists</p>' }),
    }),
  }),
}));

import { Db, getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { Session } from '@proteinjs/server-api';
import { routes, tables } from '@proteinjs/user';
import { DbSessionStore } from '../src/authentication/DbSessionStore';
import { login } from '../src/routes/login';
import { signup } from '../src/routes/signup';
import { AccountDeletion } from '../src/services/AccountDeletion';
import { productAsksForConfirmation } from './emailConfirmationHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type ObjectCache = { objectCache: Record<string, unknown[]> };
type Middleware = (req: unknown, res: unknown, next: (error?: unknown) => void) => void;
/** What a request was answered: the status, the body as sent, and the session cookie the answer set with its id. */
type Answer = { status?: number; body: string; cookie?: string; sid?: string };
/** A point a request is held at: the request waits there (`wait`); `arrived` once it does, `release` lets it go on. */
type Held = { arrived: Promise<void>; release: () => void; wait: () => Promise<void> };

const SESSION_COOKIE = 'app.sid.9877';
const AT_WORK = '/at-work';
const WHO_AM_I = '/whoami';

describe('the session store behind the real session machinery', () => {
  let server: http.Server;
  let port: number;
  let sweep: NodeJS.Timeout;
  /** Where the next request to `AT_WORK` waits before it answers. */
  let atWork: Held | undefined;
  /** Where the sign-up or log-in that carries this password waits, its route done, before its answer is sent. */
  let beforeItsAnswer: { password: string; held: Held } | undefined;

  beforeAll(async () => {
    await testEnv.beforeAll();
    (SourceRepository.get() as unknown as ObjectCache).objectCache[
      '@proteinjs/user-server/DefaultInviteConfigFactory'
    ] = [];
    productAsksForConfirmation(true);
    Session.setData({ sessionId: 'test-session', user: 'guest', data: {} });
    const db = getDbAsSystem();
    await db.delete(tables.User, {});
    await db.delete(tables.Session, {});

    // The store starts its twelve-hourly sweep as it is made; the suite ends it, or jest could not exit.
    const timers = jest.spyOn(global, 'setInterval');
    const store = new DbSessionStore();
    sweep = timers.mock.results[0].value;
    timers.mockRestore();
    server = serverWithTheRealSessionStack(store);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  }, 120000);

  afterAll(async () => {
    clearInterval(sweep);
    productAsksForConfirmation(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testEnv.afterAll();
  });

  afterEach(() => {
    atWork = undefined;
    beforeItsAnswer = undefined;
  });

  it('a session that is ended while one of its requests is at work stays ended: the end of that request writes no row for it, by a touch or by a save', async () => {
    for (const writes of [false, true]) {
      const address = `ended.at.work.${writes ? 'save' : 'touch'}@test.local`;
      const signedUp = await post(routes.signup.path, { email: address, password: 'pw-at-work-1' });
      expect(await sessionIdsOf(address)).toEqual([signedUp.sid]);

      // A request of that session is at work: the session is loaded, the answer not yet sent.
      atWork = held();
      const answered = get(`${AT_WORK}${writes ? '?writes' : ''}`, signedUp.cookie);
      await atWork.arrived;
      // The account's sessions are ended, the way everything that ends them does it.
      await getDbAsSystem().delete(tables.Session, { userEmail: address });
      atWork.release();
      await answered;

      expect(await sessionIdsOf(address)).toEqual([]);
      expect(await whoIs(signedUp.cookie)).toBeNull();
    }
  });

  it("a first write of a session's row that is aborted is made again by the same save: the sign-up ends signed in", async () => {
    const address = 'first.write.aborted@test.local';
    const write = theFirstSessionWriteFails(
      Object.assign(new Error('10 ABORTED: the transaction was aborted'), { code: 10 })
    );

    let signedUp: Answer;
    try {
      signedUp = await post(routes.signup.path, { email: address, password: 'pw-first-write-1' });
    } finally {
      write.restore();
    }

    expect(write.failed()).toBe(true);
    expect([signedUp.status, signedUp.body]).toEqual([200, '{}']);
    expect(await sessionIdsOf(address)).toEqual([signedUp.sid]);
    expect(await whoIs(signedUp.cookie)).toBe(address);
  });

  it('a session whose row cannot be written as it is made is ended in that request: the sign-up fails, and a sign-up that starts the account over before that answer is sent leaves its own session the only one', async () => {
    const address = 'first.write.fails@test.local';
    const write = theFirstSessionWriteFails(new Error('the session table is away'));
    // The first sign-up's route is done and its answer is not sent: the second runs whole there.
    beforeItsAnswer = { password: 'pw-first-1', held: held() };
    let first: Answer;
    let second: Answer;
    try {
      const firstAnswer = post(routes.signup.path, { email: address, password: 'pw-first-1' });
      await beforeItsAnswer.held.arrived;
      second = await post(routes.signup.path, { email: address, password: 'pw-second-2' });
      beforeItsAnswer.held.release();
      first = await firstAnswer;
    } finally {
      write.restore();
    }

    expect(write.failed()).toBe(true);
    expect(await sessionIdsOf(address)).toEqual([second.sid]);
    expect(await whoIs(first.cookie)).toBeNull();
    expect(await whoIs(second.cookie)).toBe(address);
    expect(first.status).toBe(500);
    expect([second.status, second.body]).toEqual([200, '{}']);
  });

  it('a sign-up that starts a waiting account over ends the session of an earlier sign-up for the address that has not finished answering', async () => {
    const address = 'not.finished.answering@test.local';
    // The first sign-up has made its session and has not sent its answer: the second runs whole there.
    beforeItsAnswer = { password: 'pw-first-1', held: held() };
    const firstAnswer = post(routes.signup.path, { email: address, password: 'pw-first-1' });
    await beforeItsAnswer.held.arrived;
    const second = await post(routes.signup.path, { email: address, password: 'pw-second-2' });
    beforeItsAnswer.held.release();
    const first = await firstAnswer;

    expect([first.status, first.body]).toEqual([200, '{}']);
    expect([second.status, second.body]).toEqual([200, '{}']);
    expect(await sessionIdsOf(address)).toEqual([second.sid]);
    expect(await whoIs(first.cookie)).toBeNull();
    expect(await whoIs(second.cookie)).toBe(address);
  });

  it("a log-in whose password was judged before a sign-up started the account over ends signed out, answered as a log-in whose password is not the account's", async () => {
    const address = 'judged.before@test.local';
    await post(routes.signup.path, { email: address, password: 'pw-first-1' });
    const refusal = JSON.parse((await post(routes.login.path, { email: address, password: 'not-the-password' })).body);
    expect(refusal.error).toBeTruthy();

    // The log-in has judged its password and has not made its session: the sign-up runs whole there.
    const afterTheJudgment = AccountDeletion.prototype.cancelPendingDeletion;
    const judged = held();
    const afterJudging = jest
      .spyOn(AccountDeletion.prototype, 'cancelPendingDeletion')
      .mockImplementationOnce(async function (this: AccountDeletion, email: string) {
        await judged.wait();
        return await afterTheJudgment.call(this, email);
      });
    let again: Answer;
    let loggedIn: Answer;
    try {
      const loggingIn = post(routes.login.path, { email: address, password: 'pw-first-1' });
      await judged.arrived;
      again = await post(routes.signup.path, { email: address, password: 'pw-second-2' });
      judged.release();
      loggedIn = await loggingIn;
    } finally {
      afterJudging.mockRestore();
    }

    expect(JSON.parse(loggedIn.body)).toEqual(refusal);
    expect(await sessionIdsOf(address)).toEqual([again.sid]);
    expect(await whoIs(loggedIn.cookie)).toBeNull();
    expect(await whoIs(again.cookie)).toBe(address);
  });

  it('a session whose account cannot be read back once it is made is ended: the sign-up fails and leaves no session', async () => {
    const address = 'not.read.back@test.local';
    const read = Db.prototype.get;
    let failed = false;
    const reads = jest.spyOn(Db.prototype, 'get').mockImplementation(async function (this: Db, ...args: any[]) {
      // The first read of an account once this account's session has its row.
      if (!failed && args[0].name === tables.User.name && (await sessionIdsOf(address)).length > 0) {
        failed = true;
        throw new Error('the account table is away');
      }
      return await (read as (...args: any[]) => Promise<any>).apply(this, args);
    });

    let answer: Answer;
    try {
      answer = await post(routes.signup.path, { email: address, password: 'pw-not-read-1' });
    } finally {
      reads.mockRestore();
    }

    expect(failed).toBe(true);
    expect(answer.status).toBe(500);
    expect(await sessionIdsOf(address)).toEqual([]);
    expect(await whoIs(answer.cookie)).toBeNull();
  });

  // ── The server, and its client ─────────────────────────────────────────────

  /** The session stack of @proteinjs/server (configureSession) over `store`, in front of the two routes. */
  function serverWithTheRealSessionStack(store: DbSessionStore): http.Server {
    const sessionMiddleware = expressSession({
      name: SESSION_COOKIE,
      secret: 'session-store-test-secret',
      store,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 24 * 60, sameSite: 'lax' },
      rolling: true,
    });
    const authenticator = new passport.Passport();
    authenticator.serializeUser((user: unknown, done: (err: unknown, id?: unknown) => void) => done(null, user));
    authenticator.deserializeUser((id: unknown, done: (err: unknown, user?: unknown) => void) => done(null, id));
    const middleware = [
      sessionMiddleware,
      authenticator.initialize(),
      authenticator.session(),
    ] as unknown as Middleware[];
    return http.createServer((req, res) => {
      const next = (index: number) => (error?: unknown) => {
        if (error) {
          res.statusCode = 500;
          res.end(String(error));
          return;
        }
        if (index >= middleware.length) {
          void answer(req, res);
          return;
        }
        middleware[index](req, res, next(index + 1));
      };
      next(0)();
    });
  }

  async function answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const request = req as unknown as Record<string, any>;
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body ?? {}));
    };
    if (url.pathname === WHO_AM_I) {
      send(200, { user: request.session?.passport?.user ?? null });
      return;
    }
    if (url.pathname === AT_WORK) {
      if (url.searchParams.has('writes')) {
        request.session.note = 'written by a request at work';
      }
      await atWork?.wait();
      send(200, {});
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    request.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    request.app = { get: () => false };
    let status = 200;
    const response = {
      status(code: number) {
        status = code;
        return response;
      },
      send(body?: unknown) {
        const point = beforeItsAnswer?.password === request.body.password ? beforeItsAnswer : undefined;
        void Promise.resolve(point?.held.wait()).then(() => send(status, body));
      },
    };
    try {
      await (url.pathname === routes.login.path ? login : signup).onRequest(req as never, response as never);
    } catch (error) {
      response.status(500).send({});
    }
  }

  /** Makes the first write of a session's row fail with `error`: `failed` says whether it has, `restore` ends it. */
  function theFirstSessionWriteFails(error: Error): { failed: () => boolean; restore: () => void } {
    const insert = Db.prototype.insert;
    let failed = false;
    const inserts = jest.spyOn(Db.prototype, 'insert').mockImplementation(async function (this: Db, ...args: any[]) {
      if (!failed && args[0].name === tables.Session.name) {
        failed = true;
        throw error;
      }
      return await (insert as (...args: any[]) => Promise<any>).apply(this, args);
    });
    return { failed: () => failed, restore: () => inserts.mockRestore() };
  }

  function post(path: string, body: unknown): Promise<Answer> {
    return ask(path, { body });
  }

  function get(path: string, cookie?: string): Promise<Answer> {
    return ask(path, { cookie });
  }

  /** Who the next request of `cookie` is: the address its session carries, or null. */
  async function whoIs(cookie: string | undefined): Promise<string | null> {
    return JSON.parse((await get(WHO_AM_I, cookie)).body).user;
  }

  function ask(path: string, options: { body?: unknown; cookie?: string }): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const clientRequest = http.request(
        {
          port,
          path,
          method: payload ? 'POST' : 'GET',
          agent: false,
          headers: {
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
            ...(options.cookie ? { cookie: options.cookie } : {}),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            const set = (res.headers['set-cookie'] ?? []).find((line) => line.startsWith(`${SESSION_COOKIE}=`));
            const cookie = set?.split(';')[0];
            // The cookie's value is `s:<session id>.<signature>`, URL-encoded.
            const sid = cookie
              ? decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1))
                  .slice(2)
                  .split('.')[0]
              : undefined;
            resolve({ status: res.statusCode, body, cookie, sid });
          });
        }
      );
      clientRequest.on('error', reject);
      clientRequest.end(payload);
    });
  }
});

/** The ids of the sessions that have a row under `address`. */
const sessionIdsOf = async (address: string): Promise<string[]> =>
  (await getDbAsSystem().query(tables.Session, { userEmail: address })).map((row) => row.sessionId);

/** A point a request can be held at. */
function held(): Held {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    arrived,
    release,
    wait: async () => {
      arrive();
      await released;
    },
  };
}
