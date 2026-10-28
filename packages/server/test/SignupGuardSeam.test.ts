import moment from 'moment';

/**
 * `POST /user/signup`'s guard seam and disposable-domain rule, on the NO-INVITE road.
 *
 * A consumer registers a `DefaultSignupGuard` (the `DefaultInviteConfigFactory` pattern) and the
 * route hands it the submission's facts; the guard answers `allow`, `refuse(sentence)` or `drop`.
 * Covered here, outcomes only (rows written, session minted, the body sent), against the Spanner
 * emulator:
 * - no guard registered: the account is created and the session established (today's behavior);
 * - `refuse`: the body is `{ error: sentence }`, no account row, no session;
 * - `drop`: the body is exactly the success shape, no account row, no session — the caller cannot tell;
 * - the invite road never consults the guard: an invited address was chosen by an admin;
 * - the facts the guard receives: the lowercased address, the form's honeypot and render token, the
 *   coarse client-address hash (never the address), the user agent's presence;
 * - the disposable-domain list: a throwaway domain and a subdomain of one refused with the one
 *   sentence before the guard runs; a real domain allowed.
 *
 * The email transport is stubbed at the module boundary (SignupRoute.test.ts pattern); the db
 * stays real. The guard is seeded into the SourceRepository cache by its qualified name, exactly
 * where the generated source graph would put a consumer's registration.
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

import { getDbAsSystem, Reference } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { RequestDigests } from '@proteinjs/util-node';
import { signup } from '../src/routes/signup';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const INVITE_CONFIG_KEY = '@proteinjs/user-server/DefaultInviteConfigFactory';
const GUARD_KEY = '@proteinjs/user-server/DefaultSignupGuard';
const DISPOSABLE_REFUSAL = 'Use an email address you can read mail at.';
const CLIENT_ADDRESS = '203.0.113.7';

type ObjectCache = { objectCache: Record<string, unknown[]> };

/** A guard a consumer would register: answers what it is told to, and keeps the facts it was handed. */
type RecordingGuard = {
  check: (facts: Record<string, unknown>) => unknown;
  received: Record<string, unknown>[];
};

const guardAnswering = (verdict: unknown): RecordingGuard => {
  const guard: RecordingGuard = {
    received: [],
    check: (facts) => {
      guard.received.push(facts);
      return verdict;
    },
  };
  return guard;
};

/** Seed the guard lookup (tests don't load the generated source graph); none = no consumer registration. */
const setGuard = (guards: unknown[]) => {
  (SourceRepository.get() as unknown as ObjectCache).objectCache[GUARD_KEY] = guards;
};

const setInviteConfig = (factories: unknown[]) => {
  (SourceRepository.get() as unknown as ObjectCache).objectCache[INVITE_CONFIG_KEY] = factories;
};

type RouteOutcome = {
  loggedInAs?: string;
  sessionEvents: string[];
  body?: { error?: string };
};

const invokeSignup = async (
  body: Record<string, unknown>,
  headers: Record<string, string> = { 'user-agent': 'a browser' }
): Promise<RouteOutcome> => {
  const { request, events } = await createPassportRequest({
    body,
    headers,
    socket: { remoteAddress: CLIENT_ADDRESS },
  });
  const outcome: RouteOutcome = { sessionEvents: events };
  const response = {
    status() {
      return this;
    },
    send(body?: unknown) {
      outcome.body = body as RouteOutcome['body'];
    },
  };
  await signup.onRequest(request as never, response as never);
  outcome.loggedInAs = request.session.passport?.user;
  return outcome;
};

const getUserRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });
const userRowCount = async () => (await getDbAsSystem().query(tables.User, {})).length;

const seedInvite = async (email: string, token: string) => {
  await getDbAsSystem().insert(tables.Invite, {
    email,
    token,
    tokenExpiresAt: moment().add(1, 'day'),
    invitedBy: new Reference(tables.User.name, 'inviter-1'),
  });
};

describe('signup route — the guard seam on the no-invite road', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  }, 120000);

  afterAll(async () => {
    delete (SourceRepository.get() as unknown as ObjectCache).objectCache[GUARD_KEY];
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    setInviteConfig([]); // invite optional: the no-invite road is open
    setGuard([]);
    const db = getDbAsSystem();
    await db.delete(tables.Invite, {});
    await db.delete(tables.User, {});
  });

  it('with no guard registered, a no-invite signup creates the account and establishes the session', async () => {
    const outcome = await invokeSignup({ name: 'Open Door', email: 'Open.Door@Test.local', password: 'pw-open-1' });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('open.door@test.local');
    expect(outcome.sessionEvents).toEqual(['regenerate', 'login', 'save']);
    expect(await getUserRow('open.door@test.local')).toBeDefined();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it(`a guard answering refuse: the body carries the guard's sentence, no account, no session`, async () => {
    setGuard([guardAnswering({ verdict: 'refuse', sentence: 'Too many sign-ups from here. Try again in an hour.' })]);

    const outcome = await invokeSignup({ name: 'Refused', email: 'refused@test.local', password: 'pw-refused-1' });

    expect(outcome.body).toEqual({ error: 'Too many sign-ups from here. Try again in an hour.' });
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);
    expect(await getUserRow('refused@test.local')).toBeUndefined();
    expect(await userRowCount()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a guard answering drop: the body is exactly the success shape, no account, no session', async () => {
    setGuard([guardAnswering({ verdict: 'drop' })]);

    const outcome = await invokeSignup({
      name: 'Bot',
      email: 'dropped@test.local',
      password: 'pw-dropped-1',
      website: 'https://filled.by.a.bot',
    });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);
    expect(await getUserRow('dropped@test.local')).toBeUndefined();
    expect(await userRowCount()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a guard answering allow lets the signup through as if none were registered', async () => {
    const guard = guardAnswering({ verdict: 'allow' });
    setGuard([guard]);

    const outcome = await invokeSignup({ name: 'Allowed', email: 'allowed@test.local', password: 'pw-allowed-1' });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('allowed@test.local');
    expect(await getUserRow('allowed@test.local')).toBeDefined();
    expect(guard.received).toHaveLength(1);
  });

  it('the invite road never consults the guard: a refusing guard, an invited signup, the account is created', async () => {
    const guard = guardAnswering({ verdict: 'refuse', sentence: 'Never shown on the invite road.' });
    setGuard([guard]);
    await seedInvite('invited@test.local', 'invite-token-guarded');

    const outcome = await invokeSignup({ name: 'Invited', password: 'pw-invited-1', token: 'invite-token-guarded' });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('invited@test.local');
    expect(outcome.sessionEvents).toEqual(['regenerate', 'login', 'save']);
    const created = await getUserRow('invited@test.local');
    expect(created).toBeDefined();
    expect(created!.emailVerified).toBe(true);
    expect(await getDbAsSystem().get(tables.Invite, { token: 'invite-token-guarded' })).toBeUndefined();
    expect(guard.received).toEqual([]);
  });

  it('the guard receives the facts: the lowercased address, the honeypot, the render token, the coarse device hash, the user agent', async () => {
    const guard = guardAnswering({ verdict: 'allow' });
    setGuard([guard]);

    await invokeSignup({
      name: 'Facts',
      email: '  Facts.Seen@Test.local ',
      password: 'pw-facts-1',
      website: '',
      formToken: '1700000000000.abc',
    });

    expect(guard.received).toEqual([
      {
        email: 'facts.seen@test.local',
        honeypot: '',
        formToken: '1700000000000.abc',
        clientDevice: new RequestDigests().coarseIp(CLIENT_ADDRESS),
        hasUserAgent: true,
      },
    ]);
    // The device is a keyed digest of the address, never the address.
    expect(JSON.stringify(guard.received)).not.toContain(CLIENT_ADDRESS);
  });

  it('a form without the honeypot or the token, from a client without a user agent, says so in the facts', async () => {
    const guard = guardAnswering({ verdict: 'allow' });
    setGuard([guard]);

    await invokeSignup({ name: 'Bare', email: 'bare@test.local', password: 'pw-bare-1' }, {});

    expect(guard.received).toHaveLength(1);
    expect(guard.received[0].honeypot).toBeUndefined();
    expect(guard.received[0].formToken).toBeUndefined();
    expect(guard.received[0].hasUserAgent).toBe(false);
  });

  it('a throwaway-mail domain is refused with the one sentence before the guard runs — no account, no session', async () => {
    const guard = guardAnswering({ verdict: 'allow' });
    setGuard([guard]);

    const outcome = await invokeSignup({ name: 'Throwaway', email: 'someone@Mailinator.com', password: 'pw-throw-1' });

    expect(outcome.body).toEqual({ error: DISPOSABLE_REFUSAL });
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);
    expect(await userRowCount()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(guard.received).toEqual([]);
  });

  it('a subdomain of a listed domain is refused with it', async () => {
    const outcome = await invokeSignup({
      name: 'Throwaway',
      email: 'someone@mail.mailinator.com',
      password: 'pw-throw-2',
    });

    expect(outcome.body).toEqual({ error: DISPOSABLE_REFUSAL });
    expect(outcome.loggedInAs).toBeUndefined();
    expect(await userRowCount()).toBe(0);
  });

  it('a domain that merely ends with a listed name, and a real domain, are allowed', async () => {
    const lookalike = await invokeSignup({
      name: 'Lookalike',
      email: 'someone@notmailinator.com',
      password: 'pw-look-1',
    });
    expect(lookalike.body).toEqual({});
    expect(await getUserRow('someone@notmailinator.com')).toBeDefined();

    const real = await invokeSignup({ name: 'Real', email: 'someone@example.com', password: 'pw-real-1' });
    expect(real.body).toEqual({});
    expect(real.loggedInAs).toBe('someone@example.com');
    expect(await getUserRow('someone@example.com')).toBeDefined();
  });

  it('an invited throwaway address is not refused by the list: the invite road is unchanged', async () => {
    await seedInvite('someone@mailinator.com', 'invite-token-throwaway');

    const outcome = await invokeSignup({ name: 'Invited', password: 'pw-invited-2', token: 'invite-token-throwaway' });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('someone@mailinator.com');
    expect(await getUserRow('someone@mailinator.com')).toBeDefined();
  });
});
