import moment, { Moment } from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { User, routes, tables } from '@proteinjs/user';
import { AccountStanding } from '../AccountStanding';
import { SecondFactorRecord } from '../SecondFactorGate';
import { AuthChallenges, ClaimedAuthChallenge } from './AuthChallenges';
import { UserPasskeys } from './UserPasskeys';
import { PasskeyAuthenticationOptions, PasskeyRegistrationOptions, WebAuthnVerifier } from './WebAuthnVerifier';

/**
 * What the sign-in door answers in place of a session when the account must use a passkey: the
 * step the page runs next, with the options its ceremony takes — `passkey` when the account has
 * one (an assertion), `addPasskey` when it has none (its first registration).
 */
export type SignInSecondStepAnswer =
  | { kind: 'passkey'; options: PasskeyAuthenticationOptions }
  | { kind: 'addPasskey'; options: PasskeyRegistrationOptions };

/** Which second-step body a request carries: the name of the field its response rides in. */
export type SignInSecondStepKind = SignInSecondStepAnswer['kind'];

/**
 * How a second-step body ended:
 * - `passed` — the factor is proven for `account`; the door restores and opens the session with `secondFactor`;
 * - `again` — refused, and answered with a new challenge (`secondStep`) inside the same five minutes;
 * - `restart` — refused, and the step is over: the page returns to the password.
 * `account` is the account the claimed challenge named, when the step got that far — for the
 * door's log line, which names it by digest. `reason` is for that line; `error` is for the person.
 */
export type SignInSecondStepOutcome =
  | { status: 'passed'; account: User; secondFactor: SecondFactorRecord }
  | { status: 'again'; account: User; reason: string; error: string; secondStep: SignInSecondStepAnswer }
  | { status: 'restart'; account?: User; reason: string; error: string };

/**
 * The passkey step of a sign-in: what the login door calls after a correct password for an
 * account that must use a passkey (`begin`), and for the two bodies that answer it (`finish`).
 * It owns the step's challenge and the cookie that binds the challenge to the browser; the door
 * owns the throttle, the log line, the pending-deletion restore and the session.
 *
 * BETWEEN THE TWO REQUESTS nothing is trusted but the cookie's token: it claims a challenge row
 * (`AuthChallenges` — single use, five minutes, of the body's own kind and purpose), and the row
 * names the account. The body carries no address. Then, in order: the account is loaded and its
 * standing re-asked (`AccountStanding` — the password step's own rule); an assertion is put to
 * the passkey rows' owner (`UserPasskeys.asserted`: the row read by the account AND the credential
 * id the response names, the response verified against the declared relying party with user
 * verification required, the passkey's use recorded); a registration is verified the same way
 * (`WebAuthnVerifier`) and enrolls the account's first passkey in one transaction that re-checks
 * it has none.
 *
 * A REFUSED ASSERTION is answered with a new challenge — at most twice, and only inside the five
 * minutes that began when the password was proven (a retry's challenge lapses when the first one
 * would have). The third refusal, a refused registration, anything after the five minutes, and a
 * token that claims nothing all end the step. A cancel in the device's own sheet makes no request,
 * so the page's retry presents the same challenge again.
 *
 * THE COOKIE carries the token and nothing else: HttpOnly; Secure outside development (the
 * session cookie's own rule); SameSite=Strict; scoped to the login path; gone with the challenge.
 */
export class SignInSecondStep {
  /** The cookie that carries the step's token. */
  static readonly COOKIE = 'signin_step';
  /** The step's life, from the moment the password was proven. */
  private static readonly LIFE_MINUTES = 5;
  /** How many assertions one password buys: the first, and one more for each of two refusals. */
  private static readonly ATTEMPTS = 3;

  /** What the person is told. The page may say it in its own words; these are the door's. */
  private static readonly TRY_AGAIN = 'That didn’t work. Try again.';
  private static readonly REFUSED = 'That didn’t work. Sign in again.';
  private static readonly TOO_LONG = 'That took too long. Sign in again.';

  private readonly challenges = new AuthChallenges();
  private readonly passkeys = new UserPasskeys();

  constructor(
    private readonly request: any,
    private readonly response: any
  ) {}

  /**
   * Which second-step body `body` is, if it is one: it carries `passkey` or `addPasskey` (one of
   * them, an object) and neither an address nor a password. Anything else is the password body's
   * to answer — as a blank one, when it carries no address and password either.
   */
  static kindOf(body: any): SignInSecondStepKind | undefined {
    if (typeof body?.email === 'string' || typeof body?.password === 'string') {
      return undefined;
    }

    const carries = (kind: SignInSecondStepKind) => typeof body?.[kind] === 'object' && body[kind] !== null;
    if (carries('passkey') !== carries('addPasskey')) {
      return carries('passkey') ? 'passkey' : 'addPasskey';
    }

    return undefined;
  }

  /**
   * The password was just proven for `account`, which must use a passkey: mint the step's first
   * challenge, set the cookie, and resolve to the step the door answers. No session exists yet.
   */
  async begin(account: User): Promise<SignInSecondStepAnswer> {
    const provenAt = moment();
    return await this.challenge(account, provenAt, provenAt.clone().add(SignInSecondStep.LIFE_MINUTES, 'minutes'), 1);
  }

  /** Answer a second-step body: `response` is the ceremony's result as the page posted it. */
  async finish(kind: SignInSecondStepKind, response: unknown): Promise<SignInSecondStepOutcome> {
    const registering = kind === 'addPasskey';
    const claimed = await this.challenges.claim(
      this.request.cookies?.[SignInSecondStep.COOKIE],
      registering ? 'webauthn_register' : 'webauthn_login',
      registering ? 'first' : 'signin'
    );
    if (!claimed) {
      return this.restart(undefined, 'the second step has no open challenge', SignInSecondStep.TOO_LONG);
    }

    const account = await getDbAsSystem().get(tables.User, { id: claimed.userId });
    if (!account) {
      return this.restart(undefined, 'the account the second step names is gone', SignInSecondStep.REFUSED);
    }
    const standing = new AccountStanding().refusal(account);
    if (standing) {
      return this.restart(account, standing, standing);
    }

    return registering
      ? await this.register(account, claimed, response)
      : await this.assert(account, claimed, response);
  }

  /** The door ended the step without a claim (a throttled try): the cookie goes, the challenge lapses by itself. */
  abandon(): void {
    this.clearCookie();
  }

  /** Body 2: an assertion by one of the account's passkeys. */
  private async assert(
    account: User,
    claimed: ClaimedAuthChallenge,
    response: unknown
  ): Promise<SignInSecondStepOutcome> {
    const assertion = await this.passkeys.asserted(account.id, response, claimed.payload.challenge);
    if ('refused' in assertion) {
      return await this.refused(account, claimed, assertion.refused);
    }

    this.clearCookie();
    return { status: 'passed', account, secondFactor: this.record(assertion.passkey.id) };
  }

  /** Body 3: the registration of the account's first passkey. */
  private async register(
    account: User,
    claimed: ClaimedAuthChallenge,
    response: unknown
  ): Promise<SignInSecondStepOutcome> {
    const verifier = WebAuthnVerifier.forDeclaredRelyingParty();
    const verdict = await verifier.verifyRegistration(response, claimed.payload.challenge);
    if (!verdict.verified) {
      return this.restart(account, verdict.reason, SignInSecondStep.REFUSED);
    }

    // A credential that is already a passkey, here or on another account, enrolls nothing; nor
    // does a first enrollment for an account that has gained a passkey since the step began.
    const enrollment = await this.passkeys.insertFirst(account.id, verdict.credential);
    if ('refused' in enrollment) {
      const reason =
        enrollment.refused === 'taken' ? 'the credential is already enrolled' : 'the account already has a passkey';
      return this.restart(account, reason, SignInSecondStep.REFUSED);
    }

    this.clearCookie();
    return { status: 'passed', account, secondFactor: this.record(enrollment.passkey.id) };
  }

  /**
   * A refused assertion: a new challenge while the password still buys one — this was the first
   * or the second try and the five minutes have not passed — and the end of the step otherwise.
   */
  private async refused(
    account: User,
    claimed: ClaimedAuthChallenge,
    reason: string
  ): Promise<SignInSecondStepOutcome> {
    const { attempt, passwordProvenAt } = claimed.payload;
    if (attempt >= SignInSecondStep.ATTEMPTS || !moment().isBefore(claimed.expiresAt)) {
      return this.restart(account, reason, SignInSecondStep.REFUSED);
    }

    const secondStep = await this.challenge(account, moment(passwordProvenAt), claimed.expiresAt, attempt + 1);
    return { status: 'again', account, reason, error: SignInSecondStep.TRY_AGAIN, secondStep };
  }

  /** The step is over: the cookie goes, and the page returns to the password. */
  private restart(account: User | undefined, reason: string, error: string): SignInSecondStepOutcome {
    this.clearCookie();
    return { status: 'restart', account, reason, error };
  }

  /**
   * Mint one challenge of the step and set its cookie: an assertion's when the account has a
   * passkey, its first registration's when it has none. Every challenge of one step lapses at the
   * same moment — five minutes after the password was proven.
   */
  private async challenge(
    account: User,
    provenAt: Moment,
    expiresAt: Moment,
    attempt: number
  ): Promise<SignInSecondStepAnswer> {
    const passkeys = await this.passkeys.forAccount(account.id);
    const verifier = WebAuthnVerifier.forDeclaredRelyingParty();
    const answer: SignInSecondStepAnswer =
      passkeys.length > 0
        ? { kind: 'passkey', options: await verifier.authenticationOptions(passkeys) }
        : { kind: 'addPasskey', options: await verifier.registrationOptions(account, passkeys) };
    const token = await this.challenges.mint({
      kind: answer.kind === 'passkey' ? 'webauthn_login' : 'webauthn_register',
      userId: account.id,
      payload: {
        challenge: answer.options.challenge,
        purpose: answer.kind === 'passkey' ? 'signin' : 'first',
        passwordProvenAt: provenAt.toISOString(),
        attempt,
      },
      expiresAt,
    });
    this.response.cookie(SignInSecondStep.COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: Math.max(0, expiresAt.diff(moment())),
    });
    return answer;
  }

  /** The session's record of a passkey that just proved the factor. */
  private record(passkeyId: string): SecondFactorRecord {
    return { method: 'passkey', passkeyId, at: moment().toISOString() };
  }

  private clearCookie(): void {
    this.response.clearCookie(SignInSecondStep.COOKIE, this.cookieOptions());
  }

  /** The cookie's standing attributes — the same on the set and on the clear, or the clear does not match. */
  private cookieOptions() {
    return {
      httpOnly: true,
      secure: !process.env.DEVELOPMENT,
      sameSite: 'strict' as const,
      path: routes.login.path,
    };
  }
}
