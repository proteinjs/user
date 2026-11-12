import { createHash } from 'crypto';
import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { User, tables } from '@proteinjs/user';
import { login } from '../src/routes/login';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { AccountDeletion } from '../src/services/AccountDeletion';
import { createPassportRequest } from './passportSessionHarness';
import { SoftwareAuthenticator } from './SoftwareAuthenticator';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { LogCapture } from './LogCapture';

const testEnv = new UserServerTestEnvironment();

/**
 * `POST /user/login`, end to end against the Spanner emulator, outcomes only (what the door
 * answers, whether a session was bound, what the log holds):
 * - per account: ten refused passwords in the window, then every try — the right password too —
 *   answers "Too many attempts. Try again in a few minutes." and binds no session; an address
 *   with no account walks the same steps with the same answers; a success clears the count;
 * - per client address: fifty tries that are not successes, then the same answer for any account;
 *   successes never count, however many;
 * - a blank submission counts toward the address window, never an account's;
 * - the throttled answer takes as long as a refused password, and a refusal for an address with
 *   no account takes as long as one for an account (no timing tell either way);
 * - every refusal is a "Sign-in refused" line and every throttled answer its own "Sign-in
 *   throttled" line, each carrying the account digest and the coarse IP hash — one digest for
 *   one address however it was typed — and never the address;
 * - tries in flight at the same moment cannot all pass the account's window together;
 * - a refusal for an account still in the legacy password format takes as long as any other;
 * - a field that is not text is a blank one: the door answers, it never throws.
 *
 * And the door's passkey step (the second describe), with a relying party declared and real
 * ceremonies — a software authenticator's registrations and assertions, verified by the real
 * library: an account that holds an administrative role gets no session on its password alone;
 * the step's challenge is single use, bound to its account, its kind and its five minutes; the
 * first passkey is enrolled inside the sign-in, once; a declared machine account and a deployment
 * that declares no relying party sign in as before.
 */

const WRONG = 'User name or password incorrect';
const THROTTLED = 'Too many attempts. Try again in a few minutes.';
const BLANK = 'Email and password cannot be blank';
const RIGHT_PASSWORD = 'the right horse battery';

type Attempt = {
  sent: any;
  signedInAs?: string;
  /** The session's data at each save, as its row would hold it (see passportSessionHarness). */
  saved: Record<string, any>[];
};

/** A browser's cookie jar: sent with a request, and changed by what the response sets and clears. */
type CookieJar = Record<string, string>;

/**
 * One request at the door from `ip`, as the server sees it with no proxy in front (the dev shape).
 * `jar` is the browser's cookies: the request carries them, and a cookie the response sets or
 * clears is set in or removed from the jar, as a browser would.
 */
const post = async (
  ip: string,
  body: unknown,
  jar: CookieJar = {},
  headers: Record<string, string> = {}
): Promise<Attempt> => {
  let sent: any;
  const response: any = {
    send: (answer: any) => {
      sent = answer;
    },
    status: () => response,
    cookie: (name: string, value: string) => {
      jar[name] = value;
    },
    clearCookie: (name: string) => {
      delete jar[name];
    },
  };
  const { request, saved } = await createPassportRequest({
    body,
    headers,
    cookies: { ...jar },
    socket: { remoteAddress: ip },
    app: { get: () => false },
  });
  await login.onRequest(request, response);
  return { sent, signedInAs: request.session.passport?.user, saved };
};

/** One sign-in attempt by address and password. */
const attempt = async (ip: string, email: string, password: string, jar?: CookieJar): Promise<Attempt> =>
  await post(ip, { email, password }, jar);

const errors = async (count: number, ip: (i: number) => string, email: (i: number) => string, password: string) => {
  const answers: string[] = [];
  for (let i = 0; i < count; i++) {
    answers.push((await attempt(ip(i), email(i), password)).sent?.error);
  }
  return answers;
};

const createAccount = async (email: string, roles: string[] = []) => {
  const user = await testEnv.createUser({ name: 'Throttle User', email, roles });
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

describe('login route throttle', () => {
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

  it('fifty wrong tries from one client address across fifty accounts, then the same answer for any account; another address is unaffected', async () => {
    await createAccount('throttle-ip-target@test.local');
    const ip = () => '203.0.113.20';
    const email = (i: number) => `throttle-ip-${i}@test.local`;
    expect(await errors(50, ip, email, 'wrong guess')).toEqual(Array(50).fill(WRONG));

    const right = await attempt('203.0.113.20', 'throttle-ip-target@test.local', RIGHT_PASSWORD);
    expect(right.sent).toEqual({ error: THROTTLED });
    expect(right.signedInAs).toBeUndefined();

    const elsewhere = await attempt('203.0.113.21', 'throttle-ip-target@test.local', RIGHT_PASSWORD);
    expect(elsewhere.sent).toEqual({});
    expect(elsewhere.signedInAs).toBe('throttle-ip-target@test.local');
  });

  it('successes never count against the address: thirty sign-ins from one address, then fifty wrong tries are still judged before the window shuts', async () => {
    await createAccount('throttle-office@test.local');
    const ip = () => '203.0.113.30';
    for (let i = 0; i < 30; i++) {
      const signedIn = await attempt(ip(), 'throttle-office@test.local', RIGHT_PASSWORD);
      expect(signedIn.sent).toEqual({});
      expect(signedIn.signedInAs).toBe('throttle-office@test.local');
    }

    const email = (i: number) => `throttle-office-guess-${i}@test.local`;
    expect(await errors(50, ip, email, 'wrong guess')).toEqual(Array(50).fill(WRONG));
    expect((await attempt(ip(), 'throttle-office@test.local', RIGHT_PASSWORD)).sent).toEqual({ error: THROTTLED });
  });

  it("blank submissions count toward the client address's window, never an account's", async () => {
    await createAccount('throttle-blank@test.local');
    // Fifteen blank passwords for one account, from fifteen addresses: the account is not throttled.
    const ip = (i: number) => `192.0.2.${i + 1}`;
    expect(await errors(15, ip, () => 'throttle-blank@test.local', '')).toEqual(Array(15).fill(BLANK));
    expect((await attempt('192.0.2.100', 'throttle-blank@test.local', 'wrong guess')).sent).toEqual({ error: WRONG });

    // Fifty blank submissions from one address: its fifty-first try is throttled.
    expect(
      await errors(
        50,
        () => '192.0.2.200',
        () => '',
        ''
      )
    ).toEqual(Array(50).fill(BLANK));
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

  it('thirty wrong passwords for one account fired at once from thirty addresses: at most ten are judged, the rest are throttled', async () => {
    await createAccount('throttle-burst@test.local');

    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) => attempt(`198.51.104.${i + 1}`, 'throttle-burst@test.local', 'wrong guess'))
    );

    const judged = answers.filter((answer) => answer.sent?.error === WRONG).length;
    const throttled = answers.filter((answer) => answer.sent?.error === THROTTLED).length;
    expect(judged).toBeLessThanOrEqual(10);
    expect(judged + throttled).toBe(30);
    expect((await attempt('198.51.104.50', 'throttle-burst@test.local', RIGHT_PASSWORD)).sent).toEqual({
      error: THROTTLED,
    });
  });

  it('a refusal for an account still in the legacy sha256 format takes as long as one in the current format', async () => {
    await createAccount('throttle-timing-current@test.local');
    const legacy = await testEnv.createUser({ name: 'Throttle User', email: 'throttle-timing-legacy@test.local' });
    await getDbAsSystem().update(tables.User, {
      id: legacy.id,
      password: createHash('sha256').update(RIGHT_PASSWORD).digest('hex'),
    });

    const current: number[] = [];
    const legacyRow: number[] = [];
    for (let i = 0; i < 7; i++) {
      current.push(
        await elapsedMs(() => attempt(`100.64.4.${i + 1}`, 'throttle-timing-current@test.local', 'wrong guess'))
      );
      legacyRow.push(
        await elapsedMs(() => attempt(`100.64.5.${i + 1}`, 'throttle-timing-legacy@test.local', 'wrong guess'))
      );
    }

    // A legacy row verifies in microseconds; without the stand-in its refusal lands far under 0.6.
    const ratio = median(legacyRow) / median(current);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });

  it('a field that is not text is a blank one: the door answers and never throws', async () => {
    let sent: any;
    const response: any = {
      send: (body: any) => {
        sent = body;
      },
      status: () => response,
    };
    const { request } = await createPassportRequest({
      body: { email: 123, password: { not: 'text' } },
      headers: {},
      socket: { remoteAddress: '198.51.105.1' },
      app: { get: () => false },
    });

    await login.onRequest(request, response);

    expect(sent).toEqual({ error: BLANK });
    expect(request.session.passport?.user).toBeUndefined();
  });
});

/** The suite's relying party: what the deployment declares, and the page its ceremonies run on. */
const RELYING_PARTY = { id: 'example.test', origin: 'https://app.example.test', name: 'Example' };
const RELYING_PARTY_KEY = '@proteinjs/user-server/PasskeyRelyingParty';
const ORIGIN = { origin: RELYING_PARTY.origin };

const objectCache = () => (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache;
const declareRelyingParty = () => {
  objectCache()[RELYING_PARTY_KEY] = [{ getRelyingParty: () => RELYING_PARTY }];
};
const declareNoRelyingParty = () => {
  objectCache()[RELYING_PARTY_KEY] = [];
};

const accountRow = async (user: User) => await getDbAsSystem().get(tables.User, { id: user.id });
const passkeysOf = async (user: User) => await getDbAsSystem().query(tables.UserPasskey, { scope: user.id });
const challengesOf = async (user: User) => await getDbAsSystem().query(tables.AuthChallenge, { userId: user.id });
const openChallengesOf = async (user: User) => (await challengesOf(user)).filter((challenge) => !challenge.consumedAt);

/** A passkey row written straight into the table: an account that has one, without a ceremony. */
const plantPasskey = async (user: User, credentialId: string) =>
  await getDbAsSystem().insert(tables.UserPasskey, {
    scope: user.id,
    credentialId,
    publicKey: 'cGxhbnRlZC1wdWJsaWMta2V5',
    counter: 0,
    transports: ['internal'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    deviceType: 'singleDevice',
    backedUp: false,
    name: 'Passkey',
  });

/** The password step, with a jar to keep the step's cookie in: what the door answered and the jar. */
const passwordStep = async (ip: string, email: string) => {
  const jar: CookieJar = {};
  const step = await attempt(ip, email, RIGHT_PASSWORD, jar);
  return { jar, step, kind: step.sent?.secondStep?.kind, options: step.sent?.secondStep?.options };
};

/** Sign in with the password and add `authenticator` as the account's first passkey, through the door. */
const enroll = async (ip: string, email: string, authenticator = new SoftwareAuthenticator()) => {
  const { jar, kind, options } = await passwordStep(ip, email);
  expect(kind).toBe('addPasskey');
  const added = await post(ip, { addPasskey: authenticator.register(options, ORIGIN) }, jar);
  expect(added.sent).toEqual({});
  return authenticator;
};

describe('login route: the passkey step of an account that holds an administrative role', () => {
  beforeAll(declareRelyingParty);
  afterAll(declareNoRelyingParty);

  it('an account holding an administrative role with a passkey, the right password: the door answers the passkey step and no session is bound', async () => {
    const admin = await createAccount('passkey-headline@test.local', ['admin']);
    await plantPasskey(admin, 'aGVhZGxpbmUtY3JlZGVudGlhbA');

    const { jar, step } = await passwordStep('198.18.1.1', admin.email);

    expect(step.signedInAs).toBeUndefined();
    expect(step.saved).toEqual([]);
    expect(step.sent.secondStep?.kind).toBe('passkey');
    expect(step.sent.secondStep.options.allowCredentials.map((credential: { id: string }) => credential.id)).toEqual([
      'aGVhZGxpbmUtY3JlZGVudGlhbA',
    ]);
    expect(Object.keys(jar)).toHaveLength(1);
  });

  it('the assertion opens the session and its stored record names the passkey; a refused try spends its challenge; the same assertion posted again opens nothing', async () => {
    const admin = await createAccount('passkey-assert@test.local', ['admin']);
    const authenticator = await enroll('198.18.2.1', admin.email);
    const [passkey] = await passkeysOf(admin);
    const ip = '198.18.2.2';

    // A try the door refuses spends its challenge: a good answer to that same challenge, posted
    // with the cookie it came with, opens nothing.
    const { jar, kind, options } = await passwordStep(ip, admin.email);
    expect(kind).toBe('passkey');
    const firstCookie = { ...jar };
    const refused = await post(ip, { passkey: authenticator.assert(options, { ...ORIGIN, userVerified: false }) }, jar);
    expect(refused.sent.secondStep?.kind).toBe('passkey');
    expect(refused.signedInAs).toBeUndefined();
    const late = await post(ip, { passkey: authenticator.assert(options, ORIGIN) }, firstCookie);
    expect(late.sent.restart).toBe(true);
    expect(late.signedInAs).toBeUndefined();

    // The new challenge the refusal was answered with, answered well: the session opens, in one
    // save, carrying the record of the passkey that opened it; the passkey's use is recorded.
    const assertion = authenticator.assert(refused.sent.secondStep.options, ORIGIN);
    const secondCookie = { ...jar };
    const opened = await post(ip, { passkey: assertion }, jar);
    expect(opened.sent).toEqual({});
    expect(opened.signedInAs).toBe(admin.email);
    expect(opened.saved).toHaveLength(1);
    expect(opened.saved[0].secondFactor).toMatchObject({ method: 'passkey', passkeyId: passkey.id });
    expect(jar).toEqual({});
    const [used] = await passkeysOf(admin);
    expect(used.counter).toBe(authenticator.signatureCount);
    expect(used.lastUsedAt).toBeTruthy();

    // The same assertion again, with the cookie it came with: nothing opens.
    const replayed = await post('198.18.2.3', { passkey: assertion }, secondCookie);
    expect(replayed.sent.restart).toBe(true);
    expect(replayed.signedInAs).toBeUndefined();
    expect(replayed.saved).toEqual([]);
  });

  it('with no passkey the door answers the add step; the registration stores one passkey, writes one audit row and opens the session; after it a password alone is answered the passkey step, never the add step', async () => {
    const admin = await createAccount('passkey-add@test.local', ['admin']);
    const authenticator = new SoftwareAuthenticator();

    const { jar, step, kind, options } = await passwordStep('198.18.3.1', admin.email);
    expect(kind).toBe('addPasskey');
    expect(step.signedInAs).toBeUndefined();
    expect(await passkeysOf(admin)).toEqual([]);

    const added = await post('198.18.3.1', { addPasskey: authenticator.register(options, ORIGIN) }, jar);
    expect(added.sent).toEqual({});
    expect(added.signedInAs).toBe(admin.email);
    const passkeys = await passkeysOf(admin);
    expect(passkeys.map((passkey) => passkey.credentialId)).toEqual([authenticator.credentialId]);
    expect(added.saved).toHaveLength(1);
    expect(added.saved[0].secondFactor).toMatchObject({ method: 'passkey', passkeyId: passkeys[0].id });
    const audit = await getDbAsSystem().query(tables.UserAccountEvent, { target: admin.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: admin.id, target: admin.id, field: 'passkeys', value: 'added' });

    const next = await passwordStep('198.18.3.2', admin.email);
    expect(next.kind).toBe('passkey');
    expect(next.step.signedInAs).toBeUndefined();
  });

  it('a register challenge taken before the account enrolled is refused once it has: still one passkey, no session', async () => {
    // Whoever holds the password takes a register challenge; then the owner enrolls — which voids
    // the account's other register challenges, and no other account's.
    const admin = await createAccount('passkey-race@test.local', ['admin']);
    const other = await createAccount('passkey-race-open@test.local', ['admin']);
    const early = await passwordStep('198.18.4.1', admin.email);
    expect(early.kind).toBe('addPasskey');
    const open = await passwordStep('198.18.4.3', other.email);
    const owner = await enroll('198.18.4.2', admin.email);
    expect(await openChallengesOf(admin)).toEqual([]);
    expect(await openChallengesOf(other)).toHaveLength(1);

    const late = await post(
      '198.18.4.1',
      { addPasskey: new SoftwareAuthenticator().register(early.options, ORIGIN) },
      early.jar
    );
    expect(late.sent.restart).toBe(true);
    expect(late.signedInAs).toBeUndefined();
    expect((await passkeysOf(admin)).map((passkey) => passkey.credentialId)).toEqual([owner.credentialId]);

    // The same, when the challenge was still open as the account came to have a passkey: the
    // enrollment itself counts the account's passkeys again and refuses.
    await plantPasskey(other, 'cmFjZS1wbGFudGVkLWNyZWRlbnRpYWw');
    const second = await post(
      '198.18.4.3',
      { addPasskey: new SoftwareAuthenticator().register(open.options, ORIGIN) },
      open.jar
    );
    expect(second.sent.restart).toBe(true);
    expect(second.signedInAs).toBeUndefined();
    expect((await passkeysOf(other)).map((passkey) => passkey.credentialId)).toEqual([
      'cmFjZS1wbGFudGVkLWNyZWRlbnRpYWw',
    ]);
  });

  it(`another account's passkey answering this account's challenge is refused; a step's options name the account's own passkeys and no others`, async () => {
    const target = await createAccount('passkey-target@test.local', ['admin']);
    const targetPasskey = await enroll('198.18.5.1', target.email);
    const intruder = await createAccount('passkey-intruder@test.local', ['admin']);
    const intruderPasskey = await enroll('198.18.5.2', intruder.email);

    const { jar, options } = await passwordStep('198.18.5.3', target.email);
    expect(options.allowCredentials.map((credential: { id: string }) => credential.id)).toEqual([
      targetPasskey.credentialId,
    ]);

    const refused = await post('198.18.5.3', { passkey: intruderPasskey.assert(options, ORIGIN) }, jar);
    expect(refused.sent.error).toBeTruthy();
    expect(refused.signedInAs).toBeUndefined();
    expect(refused.saved).toEqual([]);
  });

  it('a login challenge posted as addPasskey and a register challenge posted as passkey are both refused', async () => {
    const enrolled = await createAccount('passkey-kinds-enrolled@test.local', ['admin']);
    await enroll('198.18.6.1', enrolled.email);
    const login = await passwordStep('198.18.6.2', enrolled.email);
    expect(login.kind).toBe('passkey');
    const registration = new SoftwareAuthenticator().register(
      { challenge: login.options.challenge, rp: { id: RELYING_PARTY.id } },
      ORIGIN
    );
    const asAdd = await post('198.18.6.2', { addPasskey: registration }, login.jar);
    expect(asAdd.sent.restart).toBe(true);
    expect(asAdd.signedInAs).toBeUndefined();
    expect(await passkeysOf(enrolled)).toHaveLength(1);

    const fresh = await createAccount('passkey-kinds-fresh@test.local', ['admin']);
    const register = await passwordStep('198.18.6.3', fresh.email);
    expect(register.kind).toBe('addPasskey');
    const assertion = new SoftwareAuthenticator().assert(
      { challenge: register.options.challenge, rpId: RELYING_PARTY.id },
      ORIGIN
    );
    const asPasskey = await post('198.18.6.3', { passkey: assertion }, register.jar);
    expect(asPasskey.sent.restart).toBe(true);
    expect(asPasskey.signedInAs).toBeUndefined();
    expect(await passkeysOf(fresh)).toEqual([]);
  });

  it(`a response without user verification is refused, an assertion and a registration alike; a response signed for a sibling host's origin under the same relying-party id is refused`, async () => {
    const admin = await createAccount('passkey-verify@test.local', ['admin']);
    const authenticator = await enroll('198.18.7.1', admin.email);
    const { jar, options } = await passwordStep('198.18.7.2', admin.email);

    const unverified = await post(
      '198.18.7.2',
      { passkey: authenticator.assert(options, { ...ORIGIN, userVerified: false }) },
      jar
    );
    expect(unverified.sent.error).toBeTruthy();
    expect(unverified.signedInAs).toBeUndefined();

    // The sibling's page asks the browser for this relying party's passkey; the request reaches
    // the door from that page, so its Origin header names the sibling too.
    const sibling = 'https://other.example.test';
    const elsewhere = await post(
      '198.18.7.2',
      { passkey: authenticator.assert(unverified.sent.secondStep.options, { origin: sibling }) },
      jar,
      { origin: sibling }
    );
    expect(elsewhere.sent.error).toBeTruthy();
    expect(elsewhere.signedInAs).toBeUndefined();

    const fresh = await createAccount('passkey-verify-fresh@test.local', ['admin']);
    const add = await passwordStep('198.18.7.3', fresh.email);
    const unverifiedAdd = await post(
      '198.18.7.3',
      { addPasskey: new SoftwareAuthenticator().register(add.options, { ...ORIGIN, userVerified: false }) },
      add.jar
    );
    expect(unverifiedAdd.sent.restart).toBe(true);
    expect(unverifiedAdd.signedInAs).toBeUndefined();
    expect(await passkeysOf(fresh)).toEqual([]);
  });

  it('a refused assertion is answered with a new challenge that ends when the first would have; the third refusal answers restart; so does any try after five minutes', async () => {
    const admin = await createAccount('passkey-retries@test.local', ['admin']);
    const authenticator = await enroll('198.18.8.1', admin.email);
    const stranger = new SoftwareAuthenticator();
    const ip = '198.18.8.2';

    const { jar, options } = await passwordStep(ip, admin.email);
    const [first] = await openChallengesOf(admin);
    const payload = first.payload as { passwordProvenAt: string };
    expect(first.expiresAt.diff(payload.passwordProvenAt, 'seconds')).toBe(300);

    const once = await post(ip, { passkey: stranger.assert(options, ORIGIN) }, jar);
    expect(once.sent.secondStep?.kind).toBe('passkey');
    const [second] = await openChallengesOf(admin);
    expect(second.id).not.toBe(first.id);
    expect(second.expiresAt.valueOf()).toBe(first.expiresAt.valueOf());

    const twice = await post(ip, { passkey: stranger.assert(once.sent.secondStep.options, ORIGIN) }, jar);
    expect(twice.sent.secondStep?.kind).toBe('passkey');

    const thrice = await post(ip, { passkey: stranger.assert(twice.sent.secondStep.options, ORIGIN) }, jar);
    expect(thrice.sent.restart).toBe(true);
    expect(thrice.sent.secondStep).toBeUndefined();
    expect([once, twice, thrice].map((answer) => answer.signedInAs)).toEqual([undefined, undefined, undefined]);
    expect(await openChallengesOf(admin)).toEqual([]);

    // After the five minutes, the right passkey opens nothing either.
    const lapsing = await passwordStep('198.18.8.3', admin.email);
    const [open] = await openChallengesOf(admin);
    await getDbAsSystem().update(tables.AuthChallenge, { id: open.id, expiresAt: moment().subtract(1, 'second') });
    const lapsed = await post('198.18.8.3', { passkey: authenticator.assert(lapsing.options, ORIGIN) }, lapsing.jar);
    expect(lapsed.sent.restart).toBe(true);
    expect(lapsed.signedInAs).toBeUndefined();
  });

  it('an administrative account whose deletion is pending: the password alone does not restore it; the passkey step restores it and opens the session; a deactivated one is refused at the second step', async () => {
    const pending = await createAccount('passkey-pending@test.local', ['admin']);
    const authenticator = await enroll('198.18.9.1', pending.email);
    testEnv.actAs(pending);
    await new AccountDeletion().requestDeletion(RIGHT_PASSWORD);
    expect((await accountRow(pending)).status).toBe('deactivated');

    const { jar, kind, options } = await passwordStep('198.18.9.2', pending.email);
    expect(kind).toBe('passkey');
    expect((await accountRow(pending)).status).toBe('deactivated');
    expect(await getDbAsSystem().get(tables.AccountDeletion, { userId: pending.id })).toBeTruthy();

    const opened = await post('198.18.9.2', { passkey: authenticator.assert(options, ORIGIN) }, jar);
    expect(opened.sent).toEqual({});
    expect(opened.signedInAs).toBe(pending.email);
    expect((await accountRow(pending)).status).toBe('active');
    expect(await getDbAsSystem().get(tables.AccountDeletion, { userId: pending.id })).toBeFalsy();

    // Deactivated by staff between the password and the passkey: the second step refuses.
    const deactivated = await createAccount('passkey-deactivated@test.local', ['admin']);
    const key = await enroll('198.18.9.3', deactivated.email);
    const step = await passwordStep('198.18.9.4', deactivated.email);
    await getDbAsSystem().update(tables.User, { id: deactivated.id, status: 'deactivated' });
    const refused = await post('198.18.9.4', { passkey: key.assert(step.options, ORIGIN) }, step.jar);
    expect(refused.sent.restart).toBe(true);
    expect(refused.signedInAs).toBeUndefined();
  });

  it('a declared machine account holding an administrative role signs in with its secret alone; a row marked machine by hand that is not loaded from source is answered the second step', async () => {
    const secret = 'a-generated-machine-secret';
    await getDbAsSystem().insert(tables.User, {
      name: 'Declared machine',
      email: 'passkey-machine@test.local',
      password: createHash('sha256').update(secret).digest('hex'),
      emailVerified: true,
      roles: ['admin'],
      isLoadedFromSource: true,
      machine: true,
    });
    const machine = await attempt('198.18.10.1', 'passkey-machine@test.local', secret);
    expect(machine.sent).toEqual({});
    expect(machine.signedInAs).toBe('passkey-machine@test.local');

    const marked = await createAccount('passkey-marked@test.local', ['admin']);
    await getDbAsSystem().update(tables.User, { id: marked.id, machine: true });
    const person = await passwordStep('198.18.10.2', marked.email);
    expect(person.kind).toBe('addPasskey');
    expect(person.step.signedInAs).toBeUndefined();
  });

  it('with no relying party declared, an account holding admin signs in with the password alone', async () => {
    const admin = await createAccount('passkey-undeclared@test.local', ['admin']);
    declareNoRelyingParty();
    try {
      const signedIn = await attempt('198.18.11.1', admin.email, RIGHT_PASSWORD);
      expect(signedIn.sent).toEqual({});
      expect(signedIn.signedInAs).toBe(admin.email);
    } finally {
      declareRelyingParty();
    }
  });

  it('the two unique keys hold: a credential already enrolled on one account enrolls nothing on another; a second challenge under one token hash is refused', async () => {
    const holder = await createAccount('passkey-unique-holder@test.local', ['admin']);
    const authenticator = await enroll('198.18.12.1', holder.email);
    const other = await createAccount('passkey-unique-other@test.local', ['admin']);

    const { jar, options } = await passwordStep('198.18.12.2', other.email);
    const again = await post('198.18.12.2', { addPasskey: authenticator.register(options, ORIGIN) }, jar);
    expect(again.sent.restart).toBe(true);
    expect(again.signedInAs).toBeUndefined();
    expect(await passkeysOf(other)).toEqual([]);
    expect(await passkeysOf(holder)).toHaveLength(1);

    const challenge = {
      kind: 'webauthn_login' as const,
      tokenHash: createHash('sha256').update('one token').digest('hex'),
      userId: holder.id,
      payload: {},
      expiresAt: moment().add(5, 'minutes'),
    };
    await getDbAsSystem().insert(tables.AuthChallenge, challenge);
    await expect(getDbAsSystem().insert(tables.AuthChallenge, challenge)).rejects.toThrow();
  });
});
