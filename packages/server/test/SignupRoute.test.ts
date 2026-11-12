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
 * - the built-in default admin's address is an address in use, though no row holds it: a sign-up
 *   under it, direct or by invite, is answered the same way and writes no account;
 * - invalid token / invite-only violations: honest error, no session, no account row;
 * - an invite row the previous release minted holds the token ITSELF: once DigestStandingInviteTokens
 *   has run, the link mailed back then still redeems it (nothing dies at the deploy);
 * - the invite row holds the mailed token's DIGEST, never the token: the link's token redeems it,
 *   the digest presented as a token does not;
 * - a password the server's rules refuse (too short, too common) is refused before any write.
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
import { SourceRepository } from '@proteinjs/reflection';
import { MachineAccount, PasswordPolicy, tables } from '@proteinjs/user';
import { DefaultAdminCredentials } from '../src/authentication/DefaultAdminCredentials';
import { MailedTokenValue } from '../src/authentication/MailedTokenValue';
import { signup } from '../src/routes/signup';
import { createPassportRequest } from './passportSessionHarness';
import { sha256Hex } from './sha256Hex';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { DigestStandingInviteTokens } from '../src/migrations/DigestStandingInviteTokens';

/** A well-formed invite token (what the mailed link carries) and the digest its row holds — computed here, independently of the owner. */
const INVITE_TOKEN = 'a1'.repeat(32);
const INVITE_TOKEN_DIGEST = sha256Hex(INVITE_TOKEN);
const DECLARED_INVITE_TOKEN = 'b2'.repeat(32);

const testEnv = new UserServerTestEnvironment();

const INVITE_CONFIG_KEY = '@proteinjs/user-server/DefaultInviteConfigFactory';

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
    delete (SourceRepository.get() as unknown as NamedObjectCache).namedObjectCache[LOADER_KEY];
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    setInviteConfig([]);
    setDeclarations([]);
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
      token: INVITE_TOKEN_DIGEST,
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });

    const outcome = await invokeSignup({
      name: 'Invited Signup',
      password: 'pw-invited-1',
      token: INVITE_TOKEN,
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
    expect(await db.get(tables.Invite, { token: INVITE_TOKEN_DIGEST })).toBeUndefined();
  });

  it(`an invite row minted before the digest-at-rest change holds the token in clear: after DigestStandingInviteTokens runs, the link mailed back then still redeems it`, async () => {
    const db = getDbAsSystem();
    // The row as the previous release stored it — the mailed token itself — beside a row already at rest as a digest.
    await db.insert(tables.Invite, {
      email: 'standing.invited@test.local',
      token: INVITE_TOKEN,
      tokenExpiresAt: moment().add(20, 'days'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });
    const alreadyDigested = 'c3'.repeat(32);
    await db.insert(tables.Invite, {
      email: 'fresh.invited@test.local',
      token: sha256Hex(alreadyDigested),
      tokenExpiresAt: moment().add(20, 'days'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });

    // Every standing row is digested in place, in one pass; the row count and expiries stand.
    expect(await new DigestStandingInviteTokens().record.run()).toEqual({ digested: 2 });
    expect((await db.get(tables.Invite, { email: 'standing.invited@test.local' })).token).toBe(INVITE_TOKEN_DIGEST);
    expect((await db.query(tables.Invite, {})).length).toBe(2);

    const outcome = await invokeSignup({ name: 'Standing Invitee', password: 'pw-standing-1', token: INVITE_TOKEN });

    expect(outcome.body).toEqual({});
    expect(outcome.loggedInAs).toBe('standing.invited@test.local');
    expect((await getUserRow('standing.invited@test.local'))!.emailVerified).toBe(true);
    expect(await db.get(tables.Invite, { email: 'standing.invited@test.local' })).toBeUndefined(); // consumed
  });

  it('the invite row holds the digest, never the token: the stored digest presented as a token redeems nothing', async () => {
    const db = getDbAsSystem();
    await db.insert(tables.Invite, {
      email: 'digest.invited@test.local',
      token: INVITE_TOKEN_DIGEST,
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });
    // The stored value is what the owner stores for this token, and it is not the token.
    expect(MailedTokenValue.digest(INVITE_TOKEN)).toBe(INVITE_TOKEN_DIGEST);
    expect(INVITE_TOKEN_DIGEST).not.toBe(INVITE_TOKEN);

    const outcome = await invokeSignup({ name: 'Digest Reader', password: 'pw-digest-1', token: INVITE_TOKEN_DIGEST });

    expect(outcome.body?.error).toMatch(/no longer valid/i);
    expect(outcome.loggedInAs).toBeUndefined();
    expect(outcome.sessionEvents).toEqual([]);
    expect(await getUserRow('digest.invited@test.local')).toBeUndefined();
    expect(await db.get(tables.Invite, { token: INVITE_TOKEN_DIGEST })).toBeDefined(); // untouched
  });

  it(`a password under the minimum, or on the common-passwords list, is refused in the policy's words before any write — no account, no session`, async () => {
    const short = await invokeSignup({
      name: 'Short',
      email: 'short@test.local',
      password: 'a'.repeat(PasswordPolicy.MIN_LENGTH - 1),
    });
    expect(short.body).toEqual({ error: PasswordPolicy.TOO_SHORT });
    expect(short.loggedInAs).toBeUndefined();
    expect(short.sessionEvents).toEqual([]);

    const common = await invokeSignup({ name: 'Common', email: 'common@test.local', password: 'Password1' });
    expect(common.body).toEqual({ error: PasswordPolicy.TOO_COMMON });
    expect(common.loggedInAs).toBeUndefined();
    expect(common.sessionEvents).toEqual([]);

    expect((await getDbAsSystem().query(tables.User, {})).length).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
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

  it(`the built-in default admin's address is an address in use, however it is typed: a sign-up under it — direct or by invite — is answered as success is, with no account and no session`, async () => {
    const credentials = DefaultAdminCredentials as unknown as {
      CREDENTIALS?: { username: string; password: string };
    };
    credentials.CREDENTIALS = { username: 'Built-In.Admin@test.local', password: 'a-bootstrap-password' };
    try {
      const direct = await invokeSignup({
        name: 'Squatter',
        email: 'built-in.ADMIN@test.local',
        password: 'pw-squat-admin-1',
      });
      expect(direct.body).toEqual({});
      expect(direct.loggedInAs).toBeUndefined();
      expect(direct.sessionEvents).toEqual([]);

      await getDbAsSystem().insert(tables.Invite, {
        email: 'built-in.admin@test.local',
        token: sha256Hex(DECLARED_INVITE_TOKEN),
        tokenExpiresAt: moment().add(1, 'day'),
        invitedBy: new Reference(tables.User.name, 'inviter-1'),
      });
      const invited = await invokeSignup({
        name: 'Squatter',
        password: 'pw-squat-admin-2',
        token: DECLARED_INVITE_TOKEN,
      });
      expect(invited.body).toEqual({});
      expect(invited.loggedInAs).toBeUndefined();
      expect(invited.sessionEvents).toEqual([]);

      expect(await getDbAsSystem().query(tables.User, {})).toEqual([]);
    } finally {
      credentials.CREDENTIALS = undefined;
    }

    // Where no default admin is declared, the same address registers as any other.
    const free = await invokeSignup({ name: 'Anyone', email: 'built-in.admin@test.local', password: 'pw-anyone-1' });
    expect(free.loggedInAs).toBe('built-in.admin@test.local');
    expect(await userRowCount('built-in.admin@test.local')).toBe(1);
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
      token: sha256Hex(DECLARED_INVITE_TOKEN),
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, 'inviter-1'),
    });
    const invited = await invokeSignup({ name: 'Squatter', password: 'pw-squat-2', token: DECLARED_INVITE_TOKEN });
    expect(invited.body).toEqual({ error: "This address can't be registered." });
    expect(invited.loggedInAs).toBeUndefined();

    expect(await getUserRow('declared.machine@test.local')).toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('an unknown invite token gets the honest error — no session, no account', async () => {
    const outcome = await invokeSignup({
      name: 'Token Guess',
      password: 'pw-guess-1',
      token: 'c3'.repeat(32), // well formed, never issued
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

  it('a blank name or password — or one that is not text — is refused in plain words before any write', async () => {
    const missingName = await invokeSignup({ email: 'blank@test.local', password: 'pw-blank-1' });
    expect(missingName.body?.error).toBeTruthy();
    expect(missingName.sessionEvents).toEqual([]);

    const missingPassword = await invokeSignup({ name: 'Blank', email: 'blank@test.local' });
    expect(missingPassword.body?.error).toBeTruthy();
    expect(missingPassword.sessionEvents).toEqual([]);

    // A JSON number where the password goes: the same refusal, not a failure inside the rules.
    const numberPassword = await invokeSignup({ name: 'Blank', email: 'blank@test.local', password: 12345678 });
    expect(numberPassword.body?.error).toBe('Name and password cannot be blank');
    expect(numberPassword.sessionEvents).toEqual([]);

    const numberName = await invokeSignup({ name: 42, email: 'blank@test.local', password: 'pw-blank-1' });
    expect(numberName.body?.error).toBe('Name and password cannot be blank');
    expect(numberName.sessionEvents).toEqual([]);

    expect(await getUserRow('blank@test.local')).toBeUndefined();
  });
});
