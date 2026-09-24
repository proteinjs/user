import { randomBytes } from 'crypto';
import { getDbAsSystem } from '@proteinjs/db';
import { MailSink, MailSinkRecord } from '@proteinjs/email-server';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { signup } from '../src/routes/signup';
import { Signup } from '../src/services/Signup';
import { RequestDigests } from '../src/throttle/RequestDigests';
import { LogCapture } from './LogCapture';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

/**
 * Two sign-ups for one address at the same moment. The signup door has one rule for an address
 * that already has an account: the caller gets the response a new account gets, byte for byte, no
 * session is minted, the address's owner is told by mail, and no log line names the address. A
 * race used to break it: both requests passed the existence check before either wrote, the unique
 * index on the address refused the second insert, and the database's sentence — which names the
 * address — came back as the loser's response and its log line.
 *
 * Driven end to end against the Spanner emulator: the real route, the real passport session
 * machinery, the real mail sink (`EMAIL_TRANSPORT=sink`), the log captured as the default writer
 * emits it. Each create's password hash is held until both creates have arrived, so both have
 * passed the existence check and both inserts race.
 */

const testEnv = new UserServerTestEnvironment();

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

const CONFIG_KEYS = [
  '@proteinjs/email-server/DefaultEmailConfigFactory',
  '@proteinjs/email-server/DefaultSignupConfirmationEmailConfigFactory',
  '@proteinjs/user-server/DefaultInviteConfigFactory',
];

const WELCOME_SUBJECT = 'Welcome';
const EXISTS_SUBJECT = 'Account already exists';

type SignupOutcome = {
  status: number;
  /** The body as the wire carries it (express serializes an object body as JSON). */
  bytes: string;
  loggedInAs?: string;
  sessionEvents: string[];
};

/** One sign-up through the route, the session read back off the request as passport left it. */
const signUp = async (body: Record<string, unknown>): Promise<SignupOutcome> => {
  const { request, events } = await createPassportRequest({ body });
  const outcome: SignupOutcome = { status: 200, bytes: '', sessionEvents: events };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(sent?: unknown) {
      outcome.bytes = JSON.stringify(sent);
    },
  };
  await signup.onRequest(request as never, response as never);
  outcome.loggedInAs = request.session.passport?.user;
  return outcome;
};

/**
 * Runs `run` with every account creation's password hash held until `count` hashes have started —
 * each create has passed the existence check by then, so their inserts race.
 */
const withCreatesHeldTogether = async <T>(count: number, run: () => Promise<T>): Promise<T> => {
  const hash = PasswordHasher.prototype.hash;
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => (release = resolve));
  const held = jest.spyOn(PasswordHasher.prototype, 'hash').mockImplementation(async function (
    this: PasswordHasher,
    password: string
  ) {
    const hashed = await hash.call(this, password);
    if (++arrived === count) {
      release();
    }
    await allArrived;
    return hashed;
  });
  try {
    return await run();
  } finally {
    held.mockRestore();
  }
};

/** The mail the sink holds for `address`, oldest first. */
const mailTo = (address: string): MailSinkRecord[] =>
  MailSink.get()
    .list()
    .filter((record) => record.to.includes(address))
    .reverse();

describe('two sign-ups for one address at once', () => {
  let originalTransport: string | undefined;

  beforeAll(async () => {
    await testEnv.beforeAll();
    originalTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = 'sink';
    const cache = objectCache();
    cache['@proteinjs/email-server/DefaultEmailConfigFactory'] = [
      {
        getEmailConfig: () => ({
          host: 'smtp.test.local',
          port: 465,
          secure: true,
          from: '"Example" <hi@example.com>',
        }),
      },
    ];
    cache['@proteinjs/email-server/DefaultSignupConfirmationEmailConfigFactory'] = [
      {
        getConfig: () => ({
          newUserSubject: WELCOME_SUBJECT,
          existingUserSubject: EXISTS_SUBJECT,
          getNewUserEmailContent: () => ({ text: 'welcome' }),
          getExistingUserEmailContent: () => ({ text: 'someone tried to sign up with your address' }),
        }),
      },
    ];
    // Invite-optional, the library default — the suites load src, never the generated source graph.
    cache['@proteinjs/user-server/DefaultInviteConfigFactory'] = [{ getConfig: () => ({ isInviteOnly: false }) }];
  }, 120000);

  afterAll(async () => {
    const cache = objectCache();
    for (const key of CONFIG_KEYS) {
      delete cache[key];
    }
    if (originalTransport === undefined) {
      delete process.env.EMAIL_TRANSPORT;
    } else {
      process.env.EMAIL_TRANSPORT = originalTransport;
    }
    await testEnv.afterAll();
  });

  beforeEach(() => {
    MailSink.get().clear();
  });

  it('the loser answers exactly as a plain existing address does: the same bytes, no session, one mail to the owner, no address in the log', async () => {
    // Typed with capitals, stored lowercased — the address a person types.
    const local = `race-${randomBytes(4).toString('hex')}`;
    const address = `${local}@test.local`;
    const body = { name: 'Racer', email: `${local.toUpperCase()}@Test.local`, password: 'a-password' };

    let raced: SignupOutcome[] = [];
    const log = await LogCapture.during(async () => {
      raced = await withCreatesHeldTogether(2, () => Promise.all([signUp(body), signUp(body)]));
    });
    const racedMail = mailTo(address);

    // A plain sign-up for the address that now exists: the response the rule promises.
    const plain = await signUp(body);
    expect(plain.loggedInAs).toBeUndefined();

    // Both racers got that response, byte for byte.
    expect(raced.map((outcome) => [outcome.status, outcome.bytes])).toEqual([
      [plain.status, plain.bytes],
      [plain.status, plain.bytes],
    ]);
    // One account; one session, for the racer that created it; the loser none at all.
    expect((await getDbAsSystem().query(tables.User, { email: address })).length).toBe(1);
    expect(raced.filter((outcome) => outcome.loggedInAs === address)).toHaveLength(1);
    const loser = raced.find((outcome) => outcome.loggedInAs === undefined);
    expect(loser?.sessionEvents).toEqual([]);
    // The owner's mail: the winner's welcome and ONE notice that someone tried the address again.
    expect(racedMail.map((record) => record.subject).sort()).toEqual([EXISTS_SUBJECT, WELCOME_SUBJECT].sort());

    // No line this process wrote names the address (its local part, in any case or encoding) except the database
    // driver's own line for the refused statement: the driver's version (the one a package lock
    // pins) decides whether that line prints bound values; it is the driver's to keep clean.
    const lines = log.lines.filter((line) => !line.includes('[SpannerDriver]'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.toLowerCase().includes(local))).toEqual([]);
    // The account lines name the account by its digest: the winner's `Created user` and the
    // loser's `already exists`, each carrying the same digest for the one address.
    const digest = new RequestDigests().account(address);
    expect(lines.filter((line) => line.includes('Created user') && line.includes(digest))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('already exists') && line.includes(digest))).toHaveLength(1);
  });

  it('a create that loses the race to the same address reports it as existing, the account row the winner wrote untouched', async () => {
    const local = `race-${randomBytes(4).toString('hex')}`;
    const address = `${local}@test.local`;
    // Both creates carry the address as typed (capitals): the row is stored lowercased, and the
    // loser's re-read must ask for the address the way the row holds it.
    const account = (name: string) => ({
      name,
      email: `${local.toUpperCase()}@Test.local`,
      password: 'a-password',
      emailVerified: false,
      invitedBy: null,
    });

    const outcomes = await withCreatesHeldTogether(2, () =>
      Promise.all([new Signup().createAccount(account('First')), new Signup().createAccount(account('Second'))])
    );

    expect(outcomes.slice().sort()).toEqual(['created', 'exists']);
    const rows = await getDbAsSystem().query(tables.User, { email: address });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(outcomes[0] === 'created' ? 'First' : 'Second');
  });

  it('an insert the database refuses while the address has no account is a real failure: it throws, never "exists"', async () => {
    const address = `race-${randomBytes(4).toString('hex')}@test.local`;
    // The name column holds 255 characters; the database refuses a longer one.
    const create = new Signup().createAccount({
      name: 'n'.repeat(300),
      email: address,
      password: 'a-password',
      emailVerified: false,
      invitedBy: null,
    });

    await expect(create).rejects.toThrow();
    expect(await getDbAsSystem().query(tables.User, { email: address })).toHaveLength(0);
  });
});
