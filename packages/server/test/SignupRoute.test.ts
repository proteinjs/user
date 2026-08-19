import sha256 from 'crypto-js/sha256';
import moment from 'moment';

/**
 * `POST /user/signup` — signup with auto-login. Signup used to be an RPC service, and services
 * never see the request, so the client was bounced to the login form to type the credentials it
 * had JUST submitted. Session establishment is a request-level concern; signup now lives at the
 * route layer beside its siblings (login, dev login) and mints the session through the same
 * single owner (`establishSession`) in the same request.
 *
 * Covered here, outcomes only (rows written, session minted), against the Spanner emulator:
 * - plain signup: account row created, session established in the same request;
 * - invited signup: email resolved from the invite, invite consumed, session established;
 * - already-registered email: response body indistinguishable from success, but NO session —
 *   auto-login must never hand out a session for an account the caller didn't just create;
 * - invalid token / invite-only violations: honest error, no session, no account row.
 *
 * The email transport is stubbed at the module boundary (SignupInvite.test.ts pattern); the db
 * stays real.
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

import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { signup } from '../src/routes/signup';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const INVITE_CONFIG_KEY = '@proteinjs/user-server/DefaultInviteConfigFactory';

type ObjectCache = { objectCache: Record<string, unknown[]> };

/** Seed the invite-config lookup (tests don't load the generated source graph). */
const setInviteConfig = (factories: unknown[]) => {
  (SourceRepository.get() as unknown as ObjectCache).objectCache[INVITE_CONFIG_KEY] = factories;
};

type RouteOutcome = {
  loggedInAs?: string;
  /**
   * 'regenerate' / 'login' / 'save' in call order — recorded by the REAL passport 0.6 login
   * machinery (see passportSessionHarness): regenerate FIRST (a fresh session id on privilege
   * change, so an attacker-planted pre-auth sid never survives signup/login: session fixation),
   * then the bind of the account onto the fresh session, then save (the row must commit before
   * the response). Exactly one of each — a wrapper-level regenerate or save around
   * `request.login` would double up and break the single-owner contract.
   */
  sessionEvents: string[];
  status?: number;
  body?: { error?: string };
};

const invokeSignup = async (body: Record<string, unknown>): Promise<RouteOutcome> => {
  const { request, events } = await createPassportRequest({ body });
  const outcome: RouteOutcome = { sessionEvents: events };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body as RouteOutcome['body'];
    },
  };
  await signup.onRequest(request as never, response as never);
  // The OUTCOME of establishment: the account email bound onto the (post-regeneration) session.
  outcome.loggedInAs = request.session.passport?.user;
  return outcome;
};

const getUserRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });
const userRowCount = async (email: string) => (await getDbAsSystem().query(tables.User, { email })).length;

describe('signup route — auto-login after signup', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
    setInviteConfig([]); // default config: invite optional
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    setInviteConfig([]);
    const db = getDbAsSystem();
    await db.delete(tables.Invite, {});
    await db.delete(tables.User, {});
  });

  it('plain signup creates the account and establishes the session in the same request', async () => {
    const outcome = await invokeSignup({
      name: 'Plain Signup',
      email: 'Signup.Plain@Test.local',
      password: 'pw-plain-1',
    });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('signup.plain@test.local');
    // Fresh id on privilege change (fixation), then login, then commit-before-response (the
    // client's follow-up navigation must never race the store write and land on /login).
    expect(outcome.sessionEvents).toEqual(['regenerate', 'login', 'save']);

    const created = await getUserRow('signup.plain@test.local');
    expect(created).toBeDefined();
    expect(created!.password).toBe(sha256('pw-plain-1').toString());
    expect(created!.emailVerified).toBe(false);
    expect(created!.roles).toEqual([]);
    expect(sendEmail).toHaveBeenCalledTimes(1); // welcome email still goes out
  });

  it('invited signup resolves the email from the invite, consumes it, and establishes the session', async () => {
    const db = getDbAsSystem();
    await db.insert(tables.Invite, {
      email: 'invited@test.local',
      token: 'invite-token-1',
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: 'inviter-1',
    });

    const outcome = await invokeSignup({
      name: 'Invited Signup',
      password: 'pw-invited-1',
      token: 'invite-token-1',
    });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('invited@test.local');
    expect(outcome.sessionEvents).toEqual(['regenerate', 'login', 'save']);

    const created = await getUserRow('invited@test.local');
    expect(created).toBeDefined();
    expect(created!.emailVerified).toBe(true); // the email came from the invite record
    expect(created!.invitedBy).toBe('inviter-1');
    expect(await db.get(tables.Invite, { token: 'invite-token-1' })).toBeUndefined();
  });

  it('an already-registered email answers indistinguishably but mints NO session', async () => {
    await testEnv.createUser({ name: 'Existing User', email: 'existing@test.local' });

    const outcome = await invokeSignup({
      name: 'Existing User',
      email: 'existing@test.local',
      password: 'pw-existing-1',
    });

    // The response body must be exactly the success shape (anti-enumeration: existence is
    // reported to the mailbox owner by email, never to the caller)...
    expect(outcome.body).toEqual({});
    // ...but auto-login must never mint a session for an account the caller didn't just create.
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);

    expect(await userRowCount('existing@test.local')).toBe(1);
    const existing = await getUserRow('existing@test.local');
    expect(existing!.password).toBe('test'); // untouched — seeded by testEnv.createUser
    expect(sendEmail).toHaveBeenCalledTimes(1); // "account already exists" email
  });

  it('an unknown invite token gets the honest error — no session, no account', async () => {
    const outcome = await invokeSignup({
      name: 'Token Guess',
      password: 'pw-guess-1',
      token: 'never-existed',
    });

    expect(outcome.body?.error).toMatch(/no longer valid/i);
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);
    expect((await getDbAsSystem().query(tables.User, {})).length).toBe(0);
  });

  it('invite-only mode refuses a tokenless signup — no session, no account', async () => {
    setInviteConfig([{ getConfig: () => ({ isInviteOnly: true }) }]);

    const outcome = await invokeSignup({
      name: 'No Invite',
      email: 'no.invite@test.local',
      password: 'pw-noinvite-1',
    });

    expect(outcome.body?.error).toMatch(/invite is required/i);
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);
    expect(await getUserRow('no.invite@test.local')).toBeUndefined();
  });

  it('a blank name or password is refused before any write', async () => {
    const missingName = await invokeSignup({ email: 'blank@test.local', password: 'pw-blank-1' });
    expect(missingName.body?.error).toBeTruthy();
    expect(missingName.sessionEvents).toEqual([]);

    const missingPassword = await invokeSignup({ name: 'Blank', email: 'blank@test.local' });
    expect(missingPassword.body?.error).toBeTruthy();
    expect(missingPassword.sessionEvents).toEqual([]);

    expect(await getUserRow('blank@test.local')).toBeUndefined();
  });
});
