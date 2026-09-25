import { getDbAsSystem } from '@proteinjs/db';
import { MailSink } from '@proteinjs/email-server';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { RequestDigests as UtilRequestDigests } from '@proteinjs/util-node';
import { login } from '../src/routes/login';
import { initiatePasswordReset } from '../src/routes/initiatePasswordReset';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { PasswordResetToken } from '../src/authentication/PasswordResetToken';
import { RequestDigests } from '../src/throttle/RequestDigests';
import { SignInThrottle } from '../src/throttle/SignInThrottle';
import { PasswordResetThrottle } from '../src/throttle/PasswordResetThrottle';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { LogCapture } from './LogCapture';

const testEnv = new UserServerTestEnvironment();

/**
 * The windows keyed on something other than the device — the sign-in door's per-account window
 * and the reset door's per-address window — counted in ONE store that every server process shares
 * (a store registered through `@proteinjs/user-server/DefaultThrottleWindowStoreFactory`), so the
 * count is one across replicas and survives a deploy. Against the Spanner emulator, outcomes only:
 * - two "pods" (the door in this process, and a second process's throttle) count as one: ten wrong
 *   passwords through the door, and the second pod refuses the eleventh;
 * - a deploy (a new process with a new store instance over the same backing store) sees the old
 *   count, and the window's expiry (its TTL — equal to the window: 15 minutes per account, an hour
 *   per reset address) clears it;
 * - a success on one pod clears the account's window for every pod;
 * - the reset door's per-address window is one count across pods;
 * - the store failing or stalling is the NAMED FALLBACK: the door counts in this process's memory
 *   window until the store answers again — ten wrong passwords are judged wrong and the eleventh is
 *   refused, the right password signs in, a stalled store is judged within its deadline, the reset
 *   door still mints and mails — and the outage is one WARN line per window saying so, once however
 *   many tries meet it, and one INFO line when the store answers again;
 * - an outage's boundary continues from this process's own count (every try the store answered was
 *   counted in memory too): nine wrong in the store, then the store fails, and the eleventh is
 *   refused; on recovery the store counts from what it holds (the outage's tries were this
 *   process's own and never reach it).
 *
 * The backing store here is a stand-in for the shared one (a map every instance reads and writes,
 * the way every process reads and writes one Redis), with its own clock for the TTL.
 */

const WRONG = 'User name or password incorrect';
const THROTTLED = 'Too many attempts. Try again in a few minutes.';
const RIGHT_PASSWORD = 'the right horse battery';
const MINUTE = 60 * 1000;
const FACTORY = '@proteinjs/user-server/DefaultThrottleWindowStoreFactory';

/** Every instance reads and writes one backing map: a new instance is a new process on the same store. */
class SharedBackingStore {
  static readonly backing = new Map<string, { count: number; expiresAt: number }>();
  /** key → the window (TTL) its first count was given. */
  static readonly windows = new Map<string, number>();
  static now = () => Date.now();

  async increment(key: string, windowMs: number): Promise<number> {
    const live = this.live(key);
    const entry = live ?? { count: 0, expiresAt: SharedBackingStore.now() + windowMs };
    if (!live) {
      SharedBackingStore.windows.set(key, windowMs);
    }
    entry.count++;
    SharedBackingStore.backing.set(key, entry);
    return entry.count;
  }

  async read(key: string): Promise<number> {
    return this.live(key)?.count ?? 0;
  }

  async clear(key: string): Promise<void> {
    SharedBackingStore.backing.delete(key);
  }

  private live(key: string) {
    const entry = SharedBackingStore.backing.get(key);
    if (entry && entry.expiresAt <= SharedBackingStore.now()) {
      SharedBackingStore.backing.delete(key);
      return undefined;
    }
    return entry;
  }
}

/** A store that is down: every call fails the way a lost connection does. */
class DownStore {
  async increment(): Promise<number> {
    throw new Error('Connection is closed.');
  }
  async read(): Promise<number> {
    throw new Error('Connection is closed.');
  }
  async clear(): Promise<void> {
    throw new Error('Connection is closed.');
  }
}

/** A store that never answers (a client queueing commands while it reconnects). */
class StalledStore {
  increment(): Promise<number> {
    return new Promise(() => undefined);
  }
  read(): Promise<number> {
    return new Promise(() => undefined);
  }
  clear(): Promise<void> {
    return new Promise(() => undefined);
  }
}

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const register = (store: () => unknown) => {
  (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache[FACTORY] = [{ getStore: store }];
};

let run = 0;
/** A fresh address per test, so the counts of one test never meet another's. */
const address = (label: string) => `shared-${label}-${Date.now()}-${++run}@test.local`;
let ipSeed = 0;
/** A fresh client address per try, so the per-device window (per pod, by design) never decides. */
const freshIp = () => {
  ipSeed++;
  return `10.${(ipSeed >> 16) & 255}.${(ipSeed >> 8) & 255}.${ipSeed & 255}`;
};

type Attempt = { sent: any; signedInAs?: string };

/** One sign-in try through pod A's door (this process's `POST /user/login`). */
const signIn = async (email: string, password: string, ip = freshIp()): Promise<Attempt> => {
  let sent: any;
  const response: any = {
    send: (body: any) => {
      sent = body;
    },
    status: () => response,
  };
  const { request } = await createPassportRequest({
    body: { email, password },
    headers: {},
    socket: { remoteAddress: ip },
    app: { get: () => false },
  });
  await login.onRequest(request, response);
  return { sent, signedInAs: request.session.passport?.user };
};

const wrongTries = async (count: number, email: string) => {
  const answers: string[] = [];
  for (let i = 0; i < count; i++) {
    answers.push((await signIn(email, 'wrong guess')).sent?.error);
  }
  return answers;
};

/** One reset request through pod A's door (`POST /user/initiate-password-reset`). */
const requestReset = async (email: string, ip = freshIp()) => {
  let sent: any;
  const response: any = {
    send: (body: any) => {
      sent = body;
    },
    status: () => response,
  };
  await initiatePasswordReset.onRequest(
    { body: { email }, headers: {}, socket: { remoteAddress: ip }, app: { get: () => false } } as never,
    response
  );
  // The door answers first and works after; let the work settle before reading the row.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return sent;
};

const createAccount = async (email: string) => {
  const user = await testEnv.createUser({ name: 'Shared Window User', email });
  await getDbAsSystem().update(tables.User, { id: user.id, password: await new PasswordHasher().hash(RIGHT_PASSWORD) });
  return user;
};

const coarseIp = () => new RequestDigests().coarseIp(freshIp());

describe('the account and reset-address windows, one count across server processes', () => {
  const originalTransport = process.env.EMAIL_TRANSPORT;

  beforeAll(async () => {
    await testEnv.beforeAll();
    const objectCache = (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
    objectCache['@proteinjs/email-server/DefaultEmailConfigFactory'] = [
      {
        getEmailConfig: () => ({
          host: 'smtp.test.local',
          port: 465,
          secure: true,
          from: '"Example" <hi@example.com>',
        }),
      },
    ];
    objectCache['@proteinjs/email-server/DefaultPasswordResetEmailConfigFactory'] = [
      { getConfig: () => ({ getEmailContent: (path: string) => ({ text: `Reset: https://app.test.local/${path}` }) }) },
    ];
    process.env.EMAIL_TRANSPORT = 'sink';
  }, 120000);

  beforeEach(() => {
    SharedBackingStore.now = () => Date.now();
    register(() => new SharedBackingStore());
  });

  afterAll(async () => {
    delete (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache[FACTORY];
    if (originalTransport === undefined) {
      delete process.env.EMAIL_TRANSPORT;
    } else {
      process.env.EMAIL_TRANSPORT = originalTransport;
    }
    await testEnv.afterAll();
  });

  it('two pods count as one: ten wrong passwords through the door, and the second pod refuses the eleventh', async () => {
    const email = address('two-pods');
    await createAccount(email);
    const podB = new SignInThrottle();

    expect(await wrongTries(10, email)).toEqual(Array(10).fill(WRONG));

    expect(await podB.admit(coarseIp(), new RequestDigests().account(email))).toBe('account');
    // And back through the door: the right password is refused too, and no session is made.
    const right = await signIn(email, RIGHT_PASSWORD);
    expect(right.sent).toEqual({ error: THROTTLED });
    expect(right.signedInAs).toBeUndefined();
  });

  it('interleaved across two pods, the eleventh wrong password is refused wherever it lands', async () => {
    const email = address('interleaved');
    const account = new RequestDigests().account(email);
    const podB = new SignInThrottle();

    for (let i = 0; i < 5; i++) {
      expect((await signIn(email, 'wrong guess')).sent).toEqual({ error: WRONG });
      expect(await podB.admit(coarseIp(), account)).toBeUndefined();
    }

    expect((await signIn(email, 'wrong guess')).sent).toEqual({ error: THROTTLED });
  });

  it('a deploy sees the old count (a new process, a new store instance, the same store) — and the window’s expiry clears it', async () => {
    const email = address('deploy');
    const account = new RequestDigests().account(email);
    expect(await wrongTries(10, email)).toEqual(Array(10).fill(WRONG));

    const afterDeploy = new SignInThrottle();
    expect(await afterDeploy.admit(coarseIp(), account)).toBe('account');

    // The TTL is the window: fifteen minutes after the first counted try, the count is gone.
    const counted = Array.from(SharedBackingStore.windows.entries()).filter(([key]) => key.includes(account));
    expect(counted.map(([, windowMs]) => windowMs)).toEqual([15 * MINUTE]);
    const start = Date.now();
    SharedBackingStore.now = () => start + 15 * MINUTE + 1;
    expect(await afterDeploy.admit(coarseIp(), account)).toBeUndefined();
  });

  it("a success on one pod clears the account's window for every pod", async () => {
    const email = address('cleared');
    await createAccount(email);
    const account = new RequestDigests().account(email);
    const podB = new SignInThrottle();
    expect(await wrongTries(9, email)).toEqual(Array(9).fill(WRONG));

    // Pod B sees the account prove itself (a sign-in there, or a reset link redeemed there).
    await podB.recordSuccess(account);

    expect(await wrongTries(10, email)).toEqual(Array(10).fill(WRONG));
    expect((await signIn(email, 'wrong guess')).sent).toEqual({ error: THROTTLED });
  });

  it("the reset door's per-address window is one count across pods, with the hour as its TTL", async () => {
    const email = address('reset');
    await createAccount(email);
    const account = new UtilRequestDigests().account(email);
    const podB = new PasswordResetThrottle();

    for (let i = 0; i < 3; i++) {
      await requestReset(email);
    }

    expect(await podB.admit(new UtilRequestDigests().coarseIp(freshIp()), account)).toBe('account');
    const counted = Array.from(SharedBackingStore.windows.entries()).filter(([key]) => key.includes(account));
    expect(counted.map(([, windowMs]) => windowMs)).toEqual([60 * MINUTE]);
  });

  it('windows sharing one store never meet: three reset requests for an address leave its ten sign-in tries whole', async () => {
    const email = address('never-meet');
    await createAccount(email);

    for (let i = 0; i < 3; i++) {
      await requestReset(email);
    }

    expect(await wrongTries(10, email)).toEqual(Array(10).fill(WRONG));
    expect((await signIn(email, 'wrong guess')).sent).toEqual({ error: THROTTLED });
  });

  describe("when the store fails, the counted doors count in this process's memory until it answers", () => {
    it('a store that is down: the right password signs in, ten wrong passwords are judged wrong, the eleventh is refused (the right password too, no session) — one WARN saying so until the store answers again', async () => {
      const email = address('down');
      await createAccount(email);
      register(() => new DownStore());

      const log = await LogCapture.during(async () => {
        const first = await signIn(email, RIGHT_PASSWORD);
        expect(first.sent).toEqual({});
        expect(first.signedInAs).toBe(email);
        expect(await wrongTries(10, email)).toEqual(Array(10).fill(WRONG));
        const eleventh = await signIn(email, RIGHT_PASSWORD);
        expect(eleventh.sent).toEqual({ error: THROTTLED });
        expect(eleventh.signedInAs).toBeUndefined();
      });
      const unavailable = log.linesContaining('Throttle window store unavailable');
      expect(unavailable.lines).toHaveLength(1);
      expect(unavailable.text).toContain("counting in this process's memory until it answers");
      expect(unavailable.text).toContain('sign-in-account');
      expect(log.addresses).toEqual([]);

      // The store answers again: the door counts there again (the outage's tries were this process's
      // own), the right password signs in — and its success clears the memory window too.
      register(() => new SharedBackingStore());
      const recovered = await LogCapture.during(async () => {
        const right = await signIn(email, RIGHT_PASSWORD);
        expect(right.sent).toEqual({});
        expect(right.signedInAs).toBe(email);
      });
      expect(recovered.linesContaining('Throttle window store answering again').lines).toHaveLength(1);

      // The next outage is its own line, and the memory window starts clean.
      register(() => new DownStore());
      const again = await LogCapture.during(async () => {
        expect((await signIn(email, 'wrong guess')).sent).toEqual({ error: WRONG });
      });
      expect(again.linesContaining('Throttle window store unavailable').lines).toHaveLength(1);
    });

    it("the store fails after nine wrong tries: the memory window continues from this process's own nine — the tenth is judged wrong, the eleventh refused; one WARN", async () => {
      const email = address('boundary');
      await createAccount(email);
      expect(await wrongTries(9, email)).toEqual(Array(9).fill(WRONG));

      register(() => new DownStore());
      const log = await LogCapture.during(async () => {
        expect(await wrongTries(2, email)).toEqual([WRONG, THROTTLED]);
        const right = await signIn(email, RIGHT_PASSWORD);
        expect(right.sent).toEqual({ error: THROTTLED });
        expect(right.signedInAs).toBeUndefined();
      });
      expect(log.linesContaining('Throttle window store unavailable').lines).toHaveLength(1);
      expect(log.addresses).toEqual([]);
    });

    it("on recovery the store counts from what it holds: the outage's five wrong tries never reach the shared count (ten fresh before the refusal, one INFO) — and this process's own count, kept all along, refuses at once in the next outage", async () => {
      const email = address('recovery');
      await createAccount(email);
      register(() => new DownStore());
      expect(await wrongTries(5, email)).toEqual(Array(5).fill(WRONG));

      register(() => new SharedBackingStore());
      const recovered = await LogCapture.during(async () => {
        expect(await wrongTries(11, email)).toEqual([...Array(10).fill(WRONG), THROTTLED]);
      });
      expect(recovered.linesContaining('Throttle window store answering again').lines).toHaveLength(1);

      // Sixteen tries met this process within the window (five in the outage, eleven while the store
      // answered): when the store fails again, memory judges from all sixteen.
      register(() => new DownStore());
      expect((await signIn(email, 'wrong guess')).sent).toEqual({ error: THROTTLED });
    });

    it('a store that never answers: the door judges the try within the store deadline — not never, and not a refusal', async () => {
      const email = address('stalled');
      register(() => new StalledStore());

      const started = Date.now();
      const answer = await signIn(email, 'wrong guess');

      expect(answer.sent).toEqual({ error: WRONG });
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('the reset door with the store down: the one answer as always, AND the link minted and mailed', async () => {
      const email = address('reset-down');
      const user = await createAccount(email);
      register(() => new DownStore());
      MailSink.get().clear();

      expect(await requestReset(email)).toEqual({
        message: 'If that address has an account, a reset link is on its way.',
      });

      const row = await getDbAsSystem().get(tables.User, { id: user.id });
      expect(new PasswordResetToken().mintedAt(row)).toBeDefined();
      expect(
        MailSink.get()
          .list()
          .map((mail) => mail.to)
      ).toEqual([[email]]);
    });
  });
});
