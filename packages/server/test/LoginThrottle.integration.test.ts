import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { login } from '../src/routes/login';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { LogCapture } from './LogCapture';

const testEnv = new UserServerTestEnvironment();

/**
 * `POST /user/login`, end to end against the Spanner emulator, outcomes only (what the door
 * answers, whether a session was bound, what the log holds):
 * - per account: ten refused passwords in the window, then every try — the right password too —
 *   answers "Too many attempts. Try again in a few minutes." and binds no session; an address
 *   with no account walks the same steps with the same answers; a success clears the count;
 * - per client address: twenty tries, then the same answer for any account;
 * - a blank submission counts toward the address window, never an account's;
 * - the throttled answer takes as long as a refused password, and a refusal for an address with
 *   no account takes as long as one for an account (no timing tell either way);
 * - every refusal is a "Sign-in refused" line and every throttled answer its own "Sign-in
 *   throttled" line, each carrying the account digest and the coarse IP hash — one digest for
 *   one address however it was typed — and never the address.
 */

const WRONG = 'User name or password incorrect';
const THROTTLED = 'Too many attempts. Try again in a few minutes.';
const BLANK = 'Email and password cannot be blank';
const RIGHT_PASSWORD = 'the right horse battery';

type Attempt = { sent: any; signedInAs?: string };

/** One sign-in attempt from `ip` as the server sees it with no proxy in front (the dev shape). */
const attempt = async (ip: string, email: string, password: string): Promise<Attempt> => {
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

const errors = async (count: number, ip: (i: number) => string, email: (i: number) => string, password: string) => {
  const answers: string[] = [];
  for (let i = 0; i < count; i++) {
    answers.push((await attempt(ip(i), email(i), password)).sent?.error);
  }
  return answers;
};

const createAccount = async (email: string) => {
  const user = await testEnv.createUser({ name: 'Throttle User', email });
  await getDbAsSystem().update(tables.User, { id: user.id, password: await new PasswordHasher().hash(RIGHT_PASSWORD) });
  return user;
};

const elapsedMs = async (run: () => Promise<unknown>): Promise<number> => {
  const start = process.hrtime.bigint();
  await run();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Log text without terminal colour codes. */
const plain = (text: string) => text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

/** The `field: '<16 hex>'` values on the lines that contain `marker`. */
const fieldsOn = (log: LogCapture, marker: string, field: string): string[] =>
  log.lines
    .map(plain)
    .filter((line) => line.includes(marker))
    .map((line) => new RegExp(`${field}: '([0-9a-f]{16})'`).exec(line)?.[1] ?? 'missing');

describe('login route throttle', () => {
  const originalSecret = process.env.SESSION_SECRET;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'login-throttle-test-secret';
    await testEnv.beforeAll();
  }, 120000);

  afterAll(async () => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSecret;
    }
    await testEnv.afterAll();
  });

  it('ten wrong passwords are refused as today; the eleventh try — even with the right password — is "Too many attempts…" and no session', async () => {
    await createAccount('throttle-known@test.local');
    // Spread over many client addresses, and typed in varying case: the ACCOUNT window catches it.
    const ip = (i: number) => `198.51.100.${i + 1}`;
    const email = (i: number) => (i % 2 ? 'Throttle-Known@Test.local' : 'throttle-known@test.local');

    expect(await errors(10, ip, email, 'wrong guess')).toEqual(Array(10).fill(WRONG));

    expect((await attempt('198.51.100.50', 'throttle-known@test.local', 'wrong guess')).sent).toEqual({
      error: THROTTLED,
    });
    const right = await attempt('198.51.100.51', 'throttle-known@test.local', RIGHT_PASSWORD);
    expect(right.sent).toEqual({ error: THROTTLED });
    expect(right.signedInAs).toBeUndefined();
  });

  it('an address with no account walks the same steps with the same answers', async () => {
    const ip = (i: number) => `198.51.101.${i + 1}`;
    const email = () => 'throttle-nobody@test.local';

    expect(await errors(10, ip, email, 'wrong guess')).toEqual(Array(10).fill(WRONG));
    expect((await attempt('198.51.101.50', 'throttle-nobody@test.local', 'wrong guess')).sent).toEqual({
      error: THROTTLED,
    });
  });

  it("a success clears the account's count: after it, ten more wrong tries are refused as usual before the throttle", async () => {
    await createAccount('throttle-cleared@test.local');
    const ip = (i: number) => `198.51.102.${i + 1}`;
    const email = () => 'throttle-cleared@test.local';
    expect(await errors(9, ip, email, 'wrong guess')).toEqual(Array(9).fill(WRONG));

    const success = await attempt('198.51.102.100', 'throttle-cleared@test.local', RIGHT_PASSWORD);
    expect(success.sent).toEqual({});
    expect(success.signedInAs).toBe('throttle-cleared@test.local');

    const again = (i: number) => `198.51.102.${i + 120}`;
    expect(await errors(10, again, email, 'wrong guess')).toEqual(Array(10).fill(WRONG));
    expect((await attempt('198.51.102.200', 'throttle-cleared@test.local', 'wrong guess')).sent).toEqual({
      error: THROTTLED,
    });
  });

  it('twenty tries from one client address across twenty accounts, then the same answer for any account; another address is unaffected', async () => {
    await createAccount('throttle-ip-target@test.local');
    const ip = () => '203.0.113.20';
    const email = (i: number) => `throttle-ip-${i}@test.local`;
    expect(await errors(20, ip, email, 'wrong guess')).toEqual(Array(20).fill(WRONG));

    const right = await attempt('203.0.113.20', 'throttle-ip-target@test.local', RIGHT_PASSWORD);
    expect(right.sent).toEqual({ error: THROTTLED });
    expect(right.signedInAs).toBeUndefined();

    const elsewhere = await attempt('203.0.113.21', 'throttle-ip-target@test.local', RIGHT_PASSWORD);
    expect(elsewhere.sent).toEqual({});
    expect(elsewhere.signedInAs).toBe('throttle-ip-target@test.local');
  });

  it("blank submissions count toward the client address's window, never an account's", async () => {
    await createAccount('throttle-blank@test.local');
    // Fifteen blank passwords for one account, from fifteen addresses: the account is not throttled.
    const ip = (i: number) => `192.0.2.${i + 1}`;
    expect(await errors(15, ip, () => 'throttle-blank@test.local', '')).toEqual(Array(15).fill(BLANK));
    expect((await attempt('192.0.2.100', 'throttle-blank@test.local', 'wrong guess')).sent).toEqual({ error: WRONG });

    // Twenty blank submissions from one address: its twenty-first try is throttled.
    expect(
      await errors(
        20,
        () => '192.0.2.200',
        () => '',
        ''
      )
    ).toEqual(Array(20).fill(BLANK));
    expect((await attempt('192.0.2.200', 'throttle-blank@test.local', RIGHT_PASSWORD)).sent).toEqual({
      error: THROTTLED,
    });
  });

  it('no timing tell: the throttled answer takes as long as a refused password, and an address with no account is refused as slowly as one with', async () => {
    await createAccount('throttle-timing-open@test.local');
    await createAccount('throttle-timing-shut@test.local');
    // Push one account over its window (from addresses the samples never use).
    await errors(
      10,
      (i) => `100.64.0.${i + 1}`,
      () => 'throttle-timing-shut@test.local',
      'wrong guess'
    );

    const refused: number[] = [];
    const unknown: number[] = [];
    const throttled: number[] = [];
    // Interleaved, so machine load drifts over all three series alike; seven samples each keeps
    // the open account under its own window.
    for (let i = 0; i < 7; i++) {
      refused.push(
        await elapsedMs(() => attempt(`100.64.1.${i + 1}`, 'throttle-timing-open@test.local', 'wrong guess'))
      );
      unknown.push(
        await elapsedMs(() => attempt(`100.64.2.${i + 1}`, 'throttle-timing-none@test.local', 'wrong guess'))
      );
      throttled.push(
        await elapsedMs(() => attempt(`100.64.3.${i + 1}`, 'throttle-timing-shut@test.local', 'wrong guess'))
      );
    }

    const [r, u, t] = [median(refused), median(unknown), median(throttled)];
    // A refusal costs one database read and one password verification (argon2, tens of ms).
    // The tolerance is wide on purpose — a throttled answer or an unknown address that SKIPPED
    // the verification lands near zero or at the read alone, far outside it.
    expect(t / r).toBeGreaterThan(0.6);
    expect(t / r).toBeLessThan(1.6);
    expect(u / r).toBeGreaterThan(0.6);
    expect(u / r).toBeLessThan(1.6);
  });

  it('every refusal and every throttled answer is its own line with the account digest and the coarse IP hash — one digest per address however typed, never the address', async () => {
    await createAccount('throttle.privacy.person@test.local');
    const spellings = [
      'throttle.privacy.person@test.local',
      'Throttle.Privacy.Person@TEST.local',
      ' THROTTLE.PRIVACY.PERSON@test.local',
    ];

    const log = await LogCapture.during(async () => {
      for (let i = 0; i < 11; i++) {
        await attempt('198.51.103.7', spellings[i % 3], 'wrong guess');
      }
      await attempt('198.51.103.8', 'throttle.privacy.other@test.local', 'wrong guess');
      await attempt('198.51.103.8', '', '');
    });

    const refusedAccounts = fieldsOn(log, 'Sign-in refused', 'account');
    const throttledAccounts = fieldsOn(log, 'Sign-in throttled', 'account');
    // Ten for the person, one for the other address, one for the blank submission (no account).
    expect(refusedAccounts).toHaveLength(12);
    expect(throttledAccounts).toHaveLength(1);
    const person = refusedAccounts[0];
    expect(person).toMatch(/^[0-9a-f]{16}$/);
    expect(refusedAccounts.slice(0, 10)).toEqual(Array(10).fill(person));
    expect(throttledAccounts).toEqual([person]);
    expect(refusedAccounts[10]).toMatch(/^[0-9a-f]{16}$/);
    expect(refusedAccounts[10]).not.toBe(person);
    expect(refusedAccounts[11]).toBe('missing');

    const ips = [...fieldsOn(log, 'Sign-in refused', 'ip'), ...fieldsOn(log, 'Sign-in throttled', 'ip')];
    expect(ips).toHaveLength(13);
    expect(new Set(ips.slice(0, 10)).size).toBe(1);
    expect(ips[10]).not.toBe(ips[0]);
    expect(ips[12]).toBe(ips[0]);

    const text = plain(log.text).toLowerCase();
    for (const fragment of ['throttle.privacy.person', 'throttle.privacy.other', 'throttle.privacy', '198.51.103.']) {
      expect(text).not.toContain(fragment);
    }
  });
});
