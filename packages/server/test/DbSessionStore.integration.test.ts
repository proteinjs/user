import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { DbSessionStore } from '../src/authentication/DbSessionStore';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * The session store's two contracts with the row, against the emulator — outcomes only (what `get`
 * hands express-session, and the rows as the store leaves them):
 *
 * - `get` honors a row's expiry at the READ: express-session never checks the cookie's expiry when
 *   it loads a session (only its own MemoryStore does), so a cookie a non-browser client replayed
 *   after the idle window kept working for up to twelve hours — until the sweep's next pass deleted
 *   the row. A row whose `expires` has passed now resolves to no session before the sweep runs; a
 *   live row resolves as before; the sweep stays the row's undertaker (the expired row is still
 *   there after the refusal).
 *
 * - the store is the ONE writer of `userEmail`, and the column's form is decided there: the account
 *   row's, lowercased, whatever case the blob's `passport.user` carries — on the insert (`set`) and
 *   on every later touch alike. The column is the key every by-account session end matches; a touch
 *   re-derives it from the blob, so a row an earlier release's login door bound as typed (brought
 *   over once by NormalizeSessionAddresses, the blob left as bound) would otherwise revert on the
 *   person's next request and outlive the next reset. The blob itself stays as bound (it is
 *   passport's; the user cache lowercases on every read).
 */

const sessionBlob = (user: string) => JSON.stringify({ cookie: {}, passport: { user } });
/** A session as express-session hands the store one: a Cookie whose `expires` is a Date, the bound user. */
const boundSession = (user: string, expires: Date): Express.SessionData =>
  ({ cookie: { expires }, passport: { user } }) as unknown as Express.SessionData;

let store: DbSessionStore;

const read = (sessionId: string): Promise<Express.SessionData | null | undefined> =>
  new Promise((resolve, reject) =>
    store.get(sessionId, (error, session) => (error ? reject(error) : resolve(session)))
  );
const write = (op: 'set' | 'touch', sessionId: string, session: Express.SessionData): Promise<void> =>
  new Promise((resolve, reject) => store[op](sessionId, session, (error) => (error ? reject(error) : resolve())));

beforeAll(async () => {
  await testEnv.beforeAll();
  // The store's twelve-hour sweep timer is not the subject: faked so the suite's clock stays its own.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  store = new DbSessionStore();
  jest.useRealTimers();
});

afterAll(async () => {
  await testEnv.afterAll();
});

describe('DbSessionStore.get — a row past its expiry is no session', () => {
  beforeAll(async () => {
    const db = getDbAsSystem();
    await db.insert(tables.Session, {
      sessionId: 'live-session',
      session: sessionBlob('live@test.local'),
      expires: moment().add(1, 'day').toDate(),
      userEmail: 'live@test.local',
    });
    await db.insert(tables.Session, {
      sessionId: 'expired-session',
      session: sessionBlob('expired@test.local'),
      expires: moment().subtract(1, 'minute').toDate(),
      userEmail: 'expired@test.local',
    });
  });

  it('a live row resolves to its session', async () => {
    const session = await read('live-session');
    expect(session).toMatchObject({ passport: { user: 'live@test.local' } });
  });

  it('a row whose expiry has passed resolves to no session — before any sweep — and the row stays for the sweep', async () => {
    const session = await read('expired-session');
    expect(session ?? null).toBeNull();
    expect((await getDbAsSystem().query(tables.Session, { sessionId: 'expired-session' })).length).toBe(1);
  });

  it('an unknown id resolves to no session', async () => {
    expect((await read('never-minted')) ?? null).toBeNull();
  });
});

describe(`DbSessionStore writes the address in the account row's form — the one writer of userEmail decides its case`, () => {
  const asTyped = 'Mixed.Case@Test.local';
  const account = asTyped.toLowerCase();

  it('set: a blob bound as typed lands as a row keyed by the lowercased address; the blob stays as bound', async () => {
    await write('set', 'typed-set', boundSession(asTyped, moment().add(1, 'day').toDate()));

    const row = await getDbAsSystem().get(tables.Session, { sessionId: 'typed-set' });
    expect(row.userEmail).toBe(account);
    expect(JSON.parse(row.session).passport.user).toBe(asTyped);
  });

  it(`touch: a row brought over by NormalizeSessionAddresses (the address lowercased, the blob still as typed) keeps the lowercased address through the touch that rewrites it`, async () => {
    const db = getDbAsSystem();
    const seededExpiry = moment().add(1, 'hour').toDate();
    await db.insert(tables.Session, {
      sessionId: 'typed-touch',
      session: sessionBlob(asTyped),
      expires: seededExpiry,
      userEmail: account,
    });

    // The person's next request: express-session touches the row with the blob it loaded — the
    // address in it as the old door bound it. The store's first touch of an id is never throttled.
    await write('touch', 'typed-touch', boundSession(asTyped, moment().add(1, 'day').toDate()));

    const row = await db.get(tables.Session, { sessionId: 'typed-touch' });
    // The touch did rewrite the row (its expiry moved a day out) — and left the address where the kills find it.
    expect(moment(row.expires).isAfter(moment(seededExpiry).add(1, 'minute'))).toBe(true);
    expect(row.userEmail).toBe(account);
  });

  it(`both rows are found by the account's address — what every by-account session end matches`, async () => {
    const found = (await getDbAsSystem().query(tables.Session, { userEmail: account })).map((row) => row.sessionId);
    expect(found.sort()).toEqual(['typed-set', 'typed-touch']);
    expect(await getDbAsSystem().query(tables.Session, { userEmail: asTyped })).toEqual([]);
  });
});
