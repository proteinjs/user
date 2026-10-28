import { createHash } from 'crypto';
import moment from 'moment';

/**
 * Email verification after sign-up — the library half, outcomes only, against the Spanner
 * emulator (rows written, the context the config was handed, the mails sent, the states
 * answered):
 * - a plain sign-up's account works at once; its row stores the verification pair (the token's
 *   digest, an expiry a week out) and the welcome mail's config is handed the link that carries
 *   the token — the digest never rides the mail;
 * - an invited sign-up stores no pair and the config is handed no context: the invite mail proved
 *   the address (the regression guard on the invite road);
 * - `GET /user/verify-email?token=` spends the link once: 'confirmed' with `emailVerified` set
 *   and the pair cleared; the same token again is 'invalid' (cleared is unknown); a lapsed link
 *   is 'expired' with the flag unchanged; an unknown, malformed or missing token is 'invalid';
 *   no answer names an address;
 * - the signed-in account's re-send mints a fresh pair (the earlier link stops working) and sends
 *   one mail; inside the gap it sends nothing and the pair stands; a verified account gets
 *   `{ sent: false }` and no mail.
 * The mail transport and the config are doubled at the module boundary (SignupRoute.test.ts
 * pattern) — the config double records every context it is handed; the db stays real.
 */

const sendEmail = jest.fn();
/** Every context `getNewUserEmailContent` was handed, in call order — `undefined` when none. */
const newUserContexts: unknown[] = [];

jest.mock('@proteinjs/email-server', () => ({
  EmailSender: jest.fn().mockImplementation(() => ({ sendEmail })),
  getDefaultInviteEmailConfigFactory: () => ({
    getConfig: () => ({ getEmailContent: () => ({ text: 'invite', html: '<p>invite</p>' }) }),
  }),
  getDefaultSignupConfirmationEmailConfigFactory: () => ({
    getConfig: () => ({
      newUserSubject: 'Welcome aboard',
      getNewUserEmailContent: (context?: { verifyEmailLink?: string }) => {
        newUserContexts.push(context);
        const confirm = context?.verifyEmailLink ? ` Confirm: https://app.test/${context.verifyEmailLink}` : '';
        return { text: `welcome${confirm}`, html: '<p>welcome</p>' };
      },
    }),
  }),
}));

import { getDbAsSystem, Reference } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { tables, uiRoutes, User } from '@proteinjs/user';
import { EmailVerificationToken } from '../src/authentication/EmailVerificationToken';
import { verifyEmail } from '../src/routes/verifyEmail';
import { EMAIL_VERIFICATION_RESEND_GAP_MINUTES, Signup } from '../src/services/Signup';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type ObjectCache = { objectCache: Record<string, unknown[]> };
type RouteOutcome = { status?: number; body?: { state?: string } };

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
const EXPECTED_LIFETIME_DAYS = 7;
/** Tolerance for the clock advancing between the mint and the assertion. */
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The same `moment().add(days, 'days')` arithmetic the mint uses, so a DST boundary inside the week cancels out. */
const secondsFromExpectedLifetime = (expiration: unknown, days: number) =>
  Math.abs(moment(expiration as moment.MomentInput).diff(moment().add(days, 'days'), 'seconds'));

const userRow = async (email: string): Promise<User> => await getDbAsSystem().get(tables.User, { email });

/** The token a verify-email link carries. */
const tokenIn = (link: string | undefined): string => {
  const token = /[?&]token=([0-9a-f]{64})$/.exec(link ?? '')?.[1];
  if (!token) {
    throw new Error('The link carries no verification token');
  }
  return token;
};

/** The link the newest welcome mail's config was handed. */
const latestLink = (): string | undefined =>
  (newUserContexts[newUserContexts.length - 1] as { verifyEmailLink?: string } | undefined)?.verifyEmailLink;

/** The token in the newest mail's text — what the account's inbox actually holds. */
const mailedToken = (): string =>
  tokenIn(/https:\/\/app\.test\/(\S+)/.exec(sendEmail.mock.lastCall?.[0]?.text ?? '')?.[1]);

/** A plain (no-invite) sign-up; answers the row and the token its welcome mail carried. */
const signUp = async (email: string): Promise<{ user: User; token: string }> => {
  const result = await new Signup().createUser({ name: 'Plain Signup', email, password: 'a password' });
  expect(result.outcome).toBe('created');
  return { user: await userRow(email), token: mailedToken() };
};

const invokeVerify = async (query: Record<string, unknown>): Promise<RouteOutcome> => {
  const outcome: RouteOutcome = {};
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body as RouteOutcome['body'];
    },
  };
  await verifyEmail.onRequest({ query } as never, response as never);
  return outcome;
};

/** Moves an account's last mint back past the re-send gap, so only the flag can refuse. */
const ageLastMint = async (user: User) => {
  await getDbAsSystem().update(tables.User, {
    id: user.id,
    emailVerificationTokenExpiration: moment()
      .add(EXPECTED_LIFETIME_DAYS, 'days')
      .subtract(EMAIL_VERIFICATION_RESEND_GAP_MINUTES + 1, 'minutes'),
  });
};

describe('email verification after sign-up', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
    // Invite optional (the library's default): the no-invite road is open.
    (SourceRepository.get() as unknown as ObjectCache).objectCache[
      '@proteinjs/user-server/DefaultInviteConfigFactory'
    ] = [];
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(() => {
    sendEmail.mockClear();
    newUserContexts.length = 0;
  });

  it('a plain sign-up stores the pair — the digest, a week out — and hands the config the link carrying the token', async () => {
    const email = 'plain@test.local';

    const result = await new Signup().createUser({ name: 'Plain Signup', email, password: 'a password' });

    expect(result.outcome).toBe('created');
    const row = await userRow(email);
    expect(row.emailVerified).toBe(false);
    expect(row.emailVerificationToken).toMatch(TOKEN_SHAPE);
    expect(EmailVerificationToken.LIFETIME_DAYS).toBe(EXPECTED_LIFETIME_DAYS);
    expect(secondsFromExpectedLifetime(row.emailVerificationTokenExpiration, EXPECTED_LIFETIME_DAYS)).toBeLessThan(
      CLOCK_SKEW_TOLERANCE_SECONDS
    );

    // The context: the verify page's path carrying the token whose DIGEST the row holds.
    expect(newUserContexts).toHaveLength(1);
    const link = latestLink();
    expect(link).toMatch(new RegExp(`^${uiRoutes.account.verifyEmail}\\?token=[0-9a-f]{64}$`));
    expect(sha256Hex(tokenIn(link))).toBe(row.emailVerificationToken);
    expect(link).not.toContain(row.emailVerificationToken);

    // One mail: the welcome, under the config's new-user subject, carrying the link.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: email, subject: 'Welcome aboard' });
    expect(sendEmail.mock.calls[0][0].text).toContain(link);
  });

  it('an invited sign-up stores no pair and the config is handed no context (the invite proved the address)', async () => {
    const inviter = await testEnv.createUser({ name: 'Inviter', email: 'inviter@test.local' });
    const email = 'invited@test.local';
    await getDbAsSystem().insert(tables.Invite, {
      email,
      token: 'invite-token-verify-1',
      tokenExpiresAt: moment().add(1, 'day'),
      invitedBy: new Reference(tables.User.name, inviter.id),
    });

    const result = await new Signup().createUser(
      { name: 'Invited Signup', password: 'a password' },
      'invite-token-verify-1'
    );

    expect(result.outcome).toBe('created');
    const row = await userRow(email);
    expect(row.emailVerified).toBe(true);
    expect(row.emailVerificationToken ?? null).toBeNull();
    expect(row.emailVerificationTokenExpiration ?? null).toBeNull();
    expect(newUserContexts).toEqual([undefined]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].text).not.toContain('token=');
  });

  it('the mailed token confirms the address once: emailVerified set, the pair cleared, confirmed answered; again is invalid', async () => {
    const { user, token } = await signUp('confirm@test.local');

    const first = await invokeVerify({ token });

    expect(first).toEqual({ status: 200, body: { state: 'confirmed' } });
    const confirmed = await userRow(user.email);
    expect(confirmed.emailVerified).toBe(true);
    expect(confirmed.emailVerificationToken).toBeNull();
    expect(confirmed.emailVerificationTokenExpiration).toBeNull();

    // Spent: the cleared row no longer answers to the token, so the same link reads as unknown.
    const again = await invokeVerify({ token });
    expect(again).toEqual({ status: 200, body: { state: 'invalid' } });
    expect((await userRow(user.email)).emailVerified).toBe(true);
  });

  it('a lapsed link answers expired and leaves the flag and the pair as they were', async () => {
    const { user, token } = await signUp('lapsed@test.local');
    const lapsed = moment().subtract(1, 'minute');
    await getDbAsSystem().update(tables.User, { id: user.id, emailVerificationTokenExpiration: lapsed });

    const outcome = await invokeVerify({ token });

    expect(outcome).toEqual({ status: 200, body: { state: 'expired' } });
    const row = await userRow(user.email);
    expect(row.emailVerified).toBe(false);
    expect(row.emailVerificationToken).toBe(sha256Hex(token));
    expect(moment(row.emailVerificationTokenExpiration as moment.MomentInput).isSame(lapsed)).toBe(true);
  });

  it('an unknown, malformed or missing token is invalid, and no answer names an address', async () => {
    const { user, token } = await signUp('unknown@test.local');

    const unissued = await invokeVerify({ token: sha256Hex(`never issued ${Math.random()}`) });
    const digestAsToken = await invokeVerify({ token: sha256Hex(token) });
    const malformed = await invokeVerify({ token: 'not-a-token' });
    const missing = await invokeVerify({});
    const confirmed = await invokeVerify({ token });

    expect(unissued).toEqual({ status: 200, body: { state: 'invalid' } });
    expect(digestAsToken).toEqual({ status: 200, body: { state: 'invalid' } });
    expect(malformed).toEqual({ status: 200, body: { state: 'invalid' } });
    expect(missing).toEqual({ status: 400, body: { state: 'invalid' } });
    expect(confirmed).toEqual({ status: 200, body: { state: 'confirmed' } });
    for (const outcome of [unissued, digestAsToken, malformed, missing, confirmed]) {
      expect(JSON.stringify(outcome.body)).not.toContain(user.email);
    }
  });

  it('the signed-in account re-sends: a fresh pair (the earlier link stops working) and one mail; inside the gap nothing; verified nothing', async () => {
    const { user, token: first } = await signUp('resend@test.local');
    testEnv.actAs(user);

    // Inside the gap: no mail, the pair stands.
    const tooSoon = await new Signup().resendEmailVerification();
    expect(tooSoon).toEqual({ sent: false });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await userRow(user.email)).emailVerificationToken).toBe(sha256Hex(first));

    await ageLastMint(user);
    const resent = await new Signup().resendEmailVerification();

    expect(resent).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0]).toMatchObject({ to: user.email, subject: 'Welcome aboard' });
    const second = mailedToken();
    expect(second).not.toBe(first);
    const row = await userRow(user.email);
    expect(row.emailVerificationToken).toBe(sha256Hex(second));
    expect(secondsFromExpectedLifetime(row.emailVerificationTokenExpiration, EXPECTED_LIFETIME_DAYS)).toBeLessThan(
      CLOCK_SKEW_TOLERANCE_SECONDS
    );
    expect(newUserContexts).toEqual([
      { verifyEmailLink: `${uiRoutes.account.verifyEmail}?token=${first}` },
      { verifyEmailLink: `${uiRoutes.account.verifyEmail}?token=${second}` },
    ]);

    // The earlier link is dead; the fresh one confirms.
    expect(await invokeVerify({ token: first })).toEqual({ status: 200, body: { state: 'invalid' } });
    expect(await invokeVerify({ token: second })).toEqual({ status: 200, body: { state: 'confirmed' } });

    // Verified now: the re-send refuses without a word and sends nothing.
    const verified = await new Signup().resendEmailVerification();
    expect(verified).toEqual({ sent: false });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect((await userRow(user.email)).emailVerificationToken).toBeNull();
  });

  it('a re-send whose mail fails withdraws the token, so the next tap is not held by the gap', async () => {
    const { user, token: first } = await signUp('resend-fails@test.local');
    testEnv.actAs(user);
    await ageLastMint(user);
    sendEmail.mockRejectedValueOnce(new Error('transport refused'));

    const failed = await new Signup().resendEmailVerification();

    expect(failed).toEqual({ sent: false });
    const withdrawn = await userRow(user.email);
    expect(withdrawn.emailVerificationToken).toBeNull();
    expect(withdrawn.emailVerified).toBe(false);
    expect(await invokeVerify({ token: first })).toEqual({ status: 200, body: { state: 'invalid' } });

    const retried = await new Signup().resendEmailVerification();
    expect(retried).toEqual({ sent: true });
    expect(await invokeVerify({ token: mailedToken() })).toEqual({ status: 200, body: { state: 'confirmed' } });
  });
});
