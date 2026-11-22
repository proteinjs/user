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

import { getDbAsSystem, Reference } from '@proteinjs/db';
import { Method, SourceRepository } from '@proteinjs/reflection';
import { Session } from '@proteinjs/server-api';
import { ServiceAuth } from '@proteinjs/service/dist/src/ServiceAuth';
import { MachineAccount, tables, uiRoutes, UserRepo } from '@proteinjs/user';
import { authenticate } from '../src/authentication/authenticate';
import { BlankCredentials } from '../src/authentication/BlankCredentials';
import { EmailVerificationToken } from '../src/authentication/EmailVerificationToken';
import { PasswordSession } from '../src/authentication/PasswordSession';
import { signup } from '../src/routes/signup';
import { EMAIL_VERIFICATION_RESEND_GAP_MINUTES, Signup } from '../src/services/Signup';
import { UserPresence } from '../src/services/UserPresence';
import {
  CONFIRMATION_MAIL,
  productAsksForConfirmation,
  productWordsNoConfirmationMail,
  requestFrom,
} from './emailConfirmationHarness';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const INVITE_CONFIG_KEY = '@proteinjs/user-server/DefaultInviteConfigFactory';
const GUARD_KEY = '@proteinjs/user-server/DefaultSignupGuard';

type ObjectCache = { objectCache: Record<string, unknown[]> };
type NamedObjectCache = {
  namedObjectCache: Record<string, { qualifiedName: string; packageName: string; object: unknown }[]>;
};

/** A code-declared machine account owning an address (the declaration only — never booted here). */
class DeclaredMachineAccount extends MachineAccount {
  id = 'declared-machine';
  email = 'declared.machine@test.local';
  accountName = 'Declared machine';
  roles = [];
  secretName = 'declared-machine-secret';
}

const LOADER_KEY = '@proteinjs/db/SourceRecordLoader';

/** Seed the build's source-record declarations (the machine-account read resolves them by name). */
const setDeclarations = (declarations: unknown[]) => {
  (SourceRepository.get() as unknown as NamedObjectCache).namedObjectCache[LOADER_KEY] = declarations.map(
    (object, i) => ({
      qualifiedName: `@proteinjs/user-server-test/Declared${i}`,
      packageName: '@test/declarer',
      object,
    })
  );
};

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

const invokeSignup = async (
  body: Record<string, unknown>,
  headers: Record<string, string | undefined> = {}
): Promise<RouteOutcome> => {
  const { request, events } = await createPassportRequest({ body, headers });
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

type SignupInternals = { accountAt(email: string): Promise<unknown> };
type PasswordSessionInternals = { accountStillHolds(): Promise<boolean> };

/**
 * Whether a call for signed-in people is admitted for the request last seeded (`requestFrom`): the
 * service layer's own gate, asked of a service of this library that is for every signed-in person.
 */
const admitsACallForSignedInPeople = (): boolean =>
  ServiceAuth.canRunService(new UserPresence(), { name: 'recordPresence' } as Method, []);

/** The mail a sign-up's confirmation link is in: the product's words around the page's path and a token. */
const CONFIRMATION_MAIL_TEXT = new RegExp(
  `^Confirm: ${CONFIRMATION_MAIL.linkBase.replace(/[.]/g, '\\.')}${uiRoutes.account.verifyEmail}\\?token=[0-9a-f]{64}$`
);

/** Moves an account's last link back past the gap between two mails. */
const ageLastLink = async (email: string) => {
  const row = await getUserRow(email);
  await getDbAsSystem().update(tables.User, {
    id: row!.id,
    emailVerificationTokenExpiration: moment()
      .add(EmailVerificationToken.LIFETIME_DAYS, 'days')
      .subtract(EMAIL_VERIFICATION_RESEND_GAP_MINUTES + 1, 'minutes'),
  });
};

describe('signup route — auto-login after signup', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
    setInviteConfig([]); // default config: invite optional
  }, 120000);

  afterAll(async () => {
    delete (SourceRepository.get() as unknown as NamedObjectCache).namedObjectCache[LOADER_KEY];
    productAsksForConfirmation(false);
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    setInviteConfig([]);
    productAsksForConfirmation(false);
    (SourceRepository.get() as unknown as ObjectCache).objectCache[GUARD_KEY] = [];
    // Every case starts signed out (the signed-in case leaves its person on the session).
    Session.setData({ sessionId: 'test-session', user: 'guest', data: {} });
    setDeclarations([]);
    const db = getDbAsSystem();
    await db.delete(tables.Invite, {});
    await db.delete(tables.User, {});
    await db.delete(tables.Session, {});
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
    // At-rest contract: argon2id from the first write (the per-login-migration KDF stores
    // new credentials as argon2id directly — never a legacy sha256 row).
    expect(created!.password).toMatch(/^\$argon2id\$/);
    expect(created!.password).not.toContain('pw-plain-1');
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
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
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
    // The inviter carries over from the invite as a reference to the user record — the stored
    // bytes stay the raw id, so it reads back as a reference to the same id.
    expect(created!.invitedBy?._table).toBe(tables.User.name);
    expect(created!.invitedBy?._id).toBe('inviter-1');
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

  it(`an address a machine-account declaration owns can't be registered — by signup or by invite: plain words, no account, no session`, async () => {
    setDeclarations([new DeclaredMachineAccount()]);

    const direct = await invokeSignup({
      name: 'Squatter',
      email: 'Declared.Machine@test.local',
      password: 'pw-squat-1',
    });
    expect(direct.body).toEqual({ error: "This address can't be registered." });
    expect(direct.loggedInAs).toBeUndefined();
    expect(direct.sessionEvents).toEqual([]);

    await getDbAsSystem().insert(tables.Invite, {
      email: 'declared.machine@test.local',
      token: 'invite-token-declared',
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });
    const invited = await invokeSignup({ name: 'Squatter', password: 'pw-squat-2', token: 'invite-token-declared' });
    expect(invited.body).toEqual({ error: "This address can't be registered." });
    expect(invited.loggedInAs).toBeUndefined();

    expect(await getUserRow('declared.machine@test.local')).toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
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

  it('without an invite a blank email or password is refused before any write; with an invite a blank name is refused, as today', async () => {
    const missingPassword = await invokeSignup({ email: 'blank@test.local' });
    expect(missingPassword.body).toEqual({ error: BlankCredentials.REFUSAL });
    expect(missingPassword.sessionEvents).toEqual([]);

    const missingEmail = await invokeSignup({ password: 'pw-blank-1' });
    expect(missingEmail.body).toEqual({ error: BlankCredentials.REFUSAL });
    expect(missingEmail.sessionEvents).toEqual([]);

    await getDbAsSystem().insert(tables.Invite, {
      email: 'blank.invited@test.local',
      token: 'invite-token-blank',
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });
    const missingName = await invokeSignup({ password: 'pw-blank-2', token: 'invite-token-blank' });
    expect(missingName.body?.error).toBeTruthy();
    expect(missingName.sessionEvents).toEqual([]);

    expect((await getDbAsSystem().query(tables.User, {})).length).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a sign-up with an email and a password and no name makes the account, its name empty, and its session', async () => {
    const outcome = await invokeSignup({ email: 'no.name@test.local', password: 'pw-no-name-1' });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('no.name@test.local');
    const created = await getUserRow('no.name@test.local');
    expect(created).toBeDefined();
    expect(created!.name).toBe('');
  });

  it("a welcome mail that cannot be sent still leaves the person signed in to the new account, with the link's token withdrawn", async () => {
    sendEmail.mockRejectedValueOnce(new Error('transport refused'));

    const outcome = await invokeSignup({ email: 'mail.down@test.local', password: 'pw-mail-down-1' });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('mail.down@test.local');
    const created = await getUserRow('mail.down@test.local');
    expect(created).toBeDefined();
    expect(created!.emailVerificationToken ?? null).toBeNull();
  });

  it('a request that is already signed in and carries no invite makes no account and keeps its session', async () => {
    const signedIn = await testEnv.createUser({ name: 'Signed In', email: 'signed.in@test.local' });
    const objectCache = (SourceRepository.get() as unknown as ObjectCache).objectCache;
    objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
    testEnv.actAs(signedIn);
    try {
      const outcome = await invokeSignup({ email: 'second.account@test.local', password: 'pw-second-1' });

      expect(outcome.body).toEqual({});
      expect(outcome.sessionEvents).toEqual([]);
      expect(await getUserRow('second.account@test.local')).toBeUndefined();
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      delete objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'];
    }
  });

  it("a sign-up without an invite is asked of the invite rule with its address before anything else; where it requires an invite, the rule's sentence answers with no account, session or mail, and neither the throwaway-mail list nor the check was asked; an invited sign-up is not asked about its address", async () => {
    const RULE_SENTENCE = 'Only the listed may sign up here.';
    const askedAbout: string[] = [];
    setInviteConfig([
      {
        getConfig: () => ({ isInviteOnly: false }),
        getConfigFor: async (email: string) => {
          askedAbout.push(email);
          return { isInviteOnly: true, inviteRequiredSentence: RULE_SENTENCE };
        },
      },
    ]);
    // The check refuses with words of its own: had it been asked first, its sentence would answer.
    (SourceRepository.get() as unknown as ObjectCache).objectCache[GUARD_KEY] = [
      { check: () => ({ verdict: 'refuse', sentence: 'The check answered first.' }) },
    ];

    // A throwaway address: had the list been asked first, its own sentence would answer.
    const refused = await invokeSignup({ email: 'Someone@Mailinator.com', password: 'pw-rule-1' });

    expect(refused.body).toEqual({ error: RULE_SENTENCE });
    expect(askedAbout).toEqual(['someone@mailinator.com']);
    expect(refused.loggedInAs).toBeUndefined();
    expect(refused.sessionEvents).toEqual([]);
    expect(await getUserRow('someone@mailinator.com')).toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();

    await getDbAsSystem().insert(tables.Invite, {
      email: 'rule.invited@test.local',
      token: 'invite-token-rule',
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });
    const invited = await invokeSignup({ name: 'Invited', password: 'pw-rule-2', token: 'invite-token-rule' });

    expect(invited.body).toEqual({});
    expect(invited.loggedInAs).toBe('rule.invited@test.local');
    expect(askedAbout).toEqual(['someone@mailinator.com']);
  });

  it('a sign-up whose body was not sent as JSON is answered 415 and nothing of it is read: no account, no session, no mail; sent as JSON, it is carried out', async () => {
    const submission = { email: 'not.sent.as.json@test.local', password: 'pw-not-json-1' };
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', undefined]) {
      const outcome = await invokeSignup(submission, { 'content-type': contentType });

      expect(outcome.status).toBe(415);
      expect(typeof outcome.body?.error).toBe('string');
      expect(outcome.loggedInAs).toBeUndefined();
      expect(outcome.sessionEvents).toEqual([]);
    }
    expect(await userRowCount('not.sent.as.json@test.local')).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();

    // As a browser sends JSON, its character set named after the type.
    const asJson = await invokeSignup(submission, { 'content-type': 'application/json; charset=utf-8' });
    expect(asJson.status).toBeUndefined();
    expect(asJson.body).toEqual({});
    expect(asJson.loggedInAs).toBe('not.sent.as.json@test.local');
  });

  describe('where the product asks for the email confirmation', () => {
    beforeEach(() => {
      productAsksForConfirmation(true);
    });

    it('a sign-up without an invite ends signed in and waiting: a call for signed-in people is refused, and the one mail is the confirmation mail', async () => {
      const outcome = await invokeSignup({ email: 'Waits@Test.local', password: 'pw-waits-1' });

      expect(outcome.body).toEqual({});
      expect(outcome.loggedInAs).toBe('waits@test.local');
      expect(outcome.sessionEvents).toEqual(['regenerate', 'login', 'save']);
      await requestFrom('waits@test.local');
      expect(admitsACallForSignedInPeople()).toBe(false);

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const [mail] = sendEmail.mock.calls[0];
      expect(mail).toMatchObject({ to: 'waits@test.local', subject: CONFIRMATION_MAIL.subject });
      expect(mail.text).toMatch(CONFIRMATION_MAIL_TEXT);

      // Once its address is confirmed, the same session's request is admitted.
      const waiting = await getUserRow('waits@test.local');
      await getDbAsSystem().update(tables.User, { id: waiting!.id, emailVerified: true });
      await requestFrom('waits@test.local');
      expect(admitsACallForSignedInPeople()).toBe(true);

      // A product that words no mail of its own: the library's plain mail carries the link.
      productWordsNoConfirmationMail();
      await requestFrom(undefined);
      await invokeSignup({ email: 'plain.mail@test.local', password: 'pw-waits-2' });
      const [plain] = sendEmail.mock.lastCall!;
      expect(plain.to).toBe('plain.mail@test.local');
      expect(plain.subject).toBeTruthy();
      expect(plain.text).toMatch(new RegExp(`${uiRoutes.account.verifyEmail}\\?token=[0-9a-f]{64}`));
    });

    it('a sign-up for an address held by a waiting account starts it over: the new password logs in, the old does not, a session made before it is ended; a second one inside five minutes sends no second mail', async () => {
      const db = getDbAsSystem();
      await invokeSignup({ email: 'start.over@test.local', password: 'pw-first-1' });
      const first = await getUserRow('start.over@test.local');
      // A session of the first sign-up, as the session store keeps one; and another account's.
      const expires = moment().add(1, 'day').toDate();
      await db.insert(tables.Session, {
        sessionId: 'the-first-sign-ups-session',
        session: '{}',
        expires,
        userEmail: 'start.over@test.local',
      });
      await db.insert(tables.Session, {
        sessionId: 'another-accounts-session',
        session: '{}',
        expires,
        userEmail: 'someone.else@test.local',
      });
      await ageLastLink('start.over@test.local');

      const again = await invokeSignup({ email: 'Start.Over@Test.local', password: 'pw-second-2' });

      expect(again.body).toEqual({});
      expect(again.loggedInAs).toBe('start.over@test.local');
      expect(again.sessionEvents).toEqual(['regenerate', 'login', 'save']);
      expect(await userRowCount('start.over@test.local')).toBe(1);
      const startedOver = await getUserRow('start.over@test.local');
      expect(startedOver!.id).toBe(first!.id);
      expect(await authenticate('start.over@test.local', 'pw-second-2')).toBe(true);
      expect(await authenticate('start.over@test.local', 'pw-first-1')).not.toBe(true);
      expect(await db.get(tables.Session, { sessionId: 'the-first-sign-ups-session' })).toBeUndefined();
      expect(await db.get(tables.Session, { sessionId: 'another-accounts-session' })).toBeDefined();
      // One link at each: the first sign-up's, and the start-over's, which replaces it.
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(sendEmail.mock.calls[1][0]).toMatchObject({
        to: 'start.over@test.local',
        subject: CONFIRMATION_MAIL.subject,
      });
      expect(startedOver!.emailVerificationToken).not.toBe(first!.emailVerificationToken);
      expect(startedOver!.emailVerified).toBe(false);

      // Again inside five minutes: started over once more, and the link in the mailbox stands.
      const third = await invokeSignup({ email: 'start.over@test.local', password: 'pw-third-3' });

      expect(third.loggedInAs).toBe('start.over@test.local');
      expect(await authenticate('start.over@test.local', 'pw-third-3')).toBe(true);
      expect(await authenticate('start.over@test.local', 'pw-second-2')).not.toBe(true);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect((await getUserRow('start.over@test.local'))!.emailVerificationToken).toBe(
        startedOver!.emailVerificationToken
      );
    });

    it('an insert that loses the race for a new address starts the waiting account over and mails no You already have an account', async () => {
      // The winner of the race: its account waits, its link is in the mailbox.
      await invokeSignup({ email: 'raced@test.local', password: 'pw-winner-1' });
      expect(sendEmail).toHaveBeenCalledTimes(1);

      // The loser read the address before the winner wrote: its read misses, and the unique index
      // refuses its insert.
      const read = jest
        .spyOn(Signup.prototype as unknown as SignupInternals, 'accountAt')
        .mockResolvedValueOnce(undefined);
      let loser: RouteOutcome;
      try {
        loser = await invokeSignup({ email: 'raced@test.local', password: 'pw-loser-2' });
      } finally {
        read.mockRestore();
      }

      // Two at the same instant end as two in a row: the second starts the waiting account over.
      expect(loser.body).toEqual({});
      expect(loser.loggedInAs).toBe('raced@test.local');
      expect(await userRowCount('raced@test.local')).toBe(1);
      expect(await authenticate('raced@test.local', 'pw-loser-2')).toBe(true);
      // The winner's link is inside the gap, so it stands: nothing more is mailed, least of all the
      // notice an existing account's owner gets.
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0][0].subject).toBe(CONFIRMATION_MAIL.subject);
    });

    it('a second sign-up for one address that lands while the first is still at work ends as two in a row: the second is signed in, the password is the second one, and the first ends signed out', async () => {
      const endsAsTwoInARow = async (address: string, first: RouteOutcome, second: RouteOutcome) => {
        // Each is answered as a sign-up is. The second started the account over, so the account is its own.
        expect(first.body).toEqual({});
        expect(second.body).toEqual({});
        expect(second.loggedInAs).toBe(address);
        expect(await userRowCount(address)).toBe(1);
        expect(await authenticate(address, 'pw-second-2')).toBe(true);
        expect(await authenticate(address, 'pw-first-1')).not.toBe(true);
        // In a row, the second would have ended the first's session: the first's request leaves none.
        expect(first.loggedInAs).toBeUndefined();
      };

      // The first sign-up's mail is slow: the second sign-up runs whole inside it.
      let sendTheFirstMail!: () => void;
      const theFirstIsAtItsMail = new Promise<void>((arrived) => {
        sendEmail.mockImplementationOnce(() => {
          arrived();
          return new Promise<void>((sent) => (sendTheFirstMail = sent));
        });
      });
      let first = invokeSignup({ email: 'during.the.mail@test.local', password: 'pw-first-1' });
      await theFirstIsAtItsMail;
      let second = await invokeSignup({ email: 'During.The.Mail@Test.local', password: 'pw-second-2' });
      sendTheFirstMail();

      await endsAsTwoInARow('during.the.mail@test.local', await first, second);
      // One mail, the first's: the second's link is inside the gap, so the one in the mailbox stands.
      expect(sendEmail).toHaveBeenCalledTimes(1);

      // Later still: the first's session is made, and it is being asked whether the account still holds
      // its password, when the second runs whole.
      const ask = (PasswordSession.prototype as unknown as PasswordSessionInternals).accountStillHolds;
      let goOnAsking!: () => void;
      let asking!: jest.SpyInstance;
      const theFirstIsAsking = new Promise<void>((arrived) => {
        asking = jest
          .spyOn(PasswordSession.prototype as unknown as PasswordSessionInternals, 'accountStillHolds')
          .mockImplementationOnce(async function (this: PasswordSessionInternals) {
            arrived();
            await new Promise<void>((released) => (goOnAsking = released));
            return await ask.call(this);
          });
      });
      try {
        first = invokeSignup({ email: 'during.the.asking@test.local', password: 'pw-first-1' });
        await theFirstIsAsking;
        second = await invokeSignup({ email: 'during.the.asking@test.local', password: 'pw-second-2' });
        goOnAsking();

        await endsAsTwoInARow('during.the.asking@test.local', await first, second);
      } finally {
        asking.mockRestore();
      }
    });

    it('the same sign-up sent twice at the same moment leaves its person signed in: the account still holds the password each was made on', async () => {
      // The first is still at its mail when the second, with the same password, runs whole.
      let sendTheFirstMail!: () => void;
      const theFirstIsAtItsMail = new Promise<void>((arrived) => {
        sendEmail.mockImplementationOnce(() => {
          arrived();
          return new Promise<void>((sent) => (sendTheFirstMail = sent));
        });
      });
      const first = invokeSignup({ email: 'sent.twice@test.local', password: 'pw-same-1' });
      await theFirstIsAtItsMail;
      const second = await invokeSignup({ email: 'sent.twice@test.local', password: 'pw-same-1' });
      sendTheFirstMail();

      expect((await first).loggedInAs).toBe('sent.twice@test.local');
      expect(second.loggedInAs).toBe('sent.twice@test.local');
      expect(await userRowCount('sent.twice@test.local')).toBe(1);
      expect(await authenticate('sent.twice@test.local', 'pw-same-1')).toBe(true);
    });

    it("a confirmed account's address is answered as before, and so is a deactivated account's", async () => {
      await testEnv.createUser({ name: 'Confirmed', email: 'confirmed@test.local' });

      const confirmed = await invokeSignup({ email: 'confirmed@test.local', password: 'pw-other-1' });

      expect(confirmed.body).toEqual({});
      expect(confirmed.loggedInAs).toBeUndefined();
      expect(confirmed.sessionEvents).toEqual([]);
      expect((await getUserRow('confirmed@test.local'))!.password).toBe('test');
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0][0].text).toBe('exists');

      // An account that never confirmed and was deactivated is not started over.
      await getDbAsSystem().insert(tables.User, {
        name: 'Deactivated',
        email: 'deactivated@test.local',
        password: 'test',
        emailVerified: false,
        status: 'deactivated',
        roles: [],
      });

      const deactivated = await invokeSignup({ email: 'deactivated@test.local', password: 'pw-other-2' });

      expect(deactivated.body).toEqual({});
      expect(deactivated.loggedInAs).toBeUndefined();
      expect((await getUserRow('deactivated@test.local'))!.password).toBe('test');
      expect(sendEmail.mock.lastCall![0].text).toBe('exists');
    });

    it('an invited sign-up never waits', async () => {
      await getDbAsSystem().insert(tables.Invite, {
        email: 'invited.never.waits@test.local',
        token: 'invite-token-never-waits',
        tokenExpiresAt: moment().add(1, 'day'),
        invitedBy: new Reference(tables.User.name, 'inviter-1'),
      });

      const outcome = await invokeSignup({
        name: 'Invited',
        password: 'pw-invited-9',
        token: 'invite-token-never-waits',
      });

      expect(outcome.loggedInAs).toBe('invited.never.waits@test.local');
      expect((await getUserRow('invited.never.waits@test.local'))!.emailVerified).toBe(true);
      await requestFrom('invited.never.waits@test.local');
      expect(admitsACallForSignedInPeople()).toBe(true);
      // Its one mail is the welcome, as before: it has no address left to confirm.
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0][0].text).toBe('welcome');
    });
  });
});
