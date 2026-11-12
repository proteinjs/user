import {
  PasskeyAssertion,
  PasskeyCreationOptions,
  PasskeyRegistration,
  PasskeyRequestOptions,
  UserSignup,
  routes,
} from '@proteinjs/user';

/**
 * The passkey step the sign-in door answers IN PLACE OF a session, for an account that must use
 * one: `passkey` — the account has a passkey, and one of them answers `options`; `addPasskey` —
 * it has none yet, and `options` creates its first.
 */
export type SignInSecondStep =
  | { kind: 'passkey'; options: PasskeyRequestOptions }
  | { kind: 'addPasskey'; options: PasskeyCreationOptions };

/**
 * How an answer to the passkey step ended, as the door said it:
 * - `done` — the session is open;
 * - `again` — refused, with a new step to answer (`secondStep`) and the door's line for the person;
 * - `restart` — the step is over, with the door's line: back to the password.
 */
export type SignInSecondStepAnswer =
  | { status: 'done' }
  | { status: 'again'; line: string; secondStep: SignInSecondStep }
  | { status: 'restart'; line: string };

/**
 * What one answer of the sign-in door says, as its one reader reads it (`AuthApi.doorSays`):
 * - `open` — the session is open;
 * - `step` — a passkey step the page can run, with the door's line when one came beside it;
 * - `neither` — anything else, with the door's line when the answer carries one.
 */
type SignInDoorAnswer =
  | { says: 'open' }
  | { says: 'step'; secondStep: SignInSecondStep; line?: string }
  | { says: 'neither'; line?: string };

/**
 * The auth flows' server calls, in one place so the pages hold presentation only.
 * Methods resolve on success and throw an `Error` whose message is user-readable: the door's own
 * line when its answer carries one (`{ error }`, whatever the status — a refusal of the new
 * password by the server's rules, a reset token no longer live), the generic words only when it
 * carries none.
 */
export class AuthApi {
  /**
   * What a 429 on the sign-in, sign-up and reset doors reads as — the words the doors' own throttles
   * answer (@proteinjs/user-server `SignInThrottle.ANSWER`). A 429 there is a per-address limit in
   * front of the server (a load balancer's rate-based ban): it carries no body the form can read, and
   * over HTTP/2 no status text either, so it is named here rather than passed through.
   */
  static readonly TOO_MANY_ATTEMPTS = 'Too many attempts. Try again in a few minutes.';

  /**
   * What a sign-in reads as when the door answered a 200 that says neither that the session is
   * open nor what to do next, and carries no line of its own — the door's own words for a sign-in
   * that failed through nothing the person did (@proteinjs/user-server `routes/login`).
   */
  static readonly LOGIN_FAILED = 'Unable to log in right now. Please try again.';

  /**
   * What an answer to the passkey step reads as when the door sent no line of its own — a step
   * that failed on the server is answered by no JSON at all. The step is over either way.
   */
  static readonly STEP_OVER = 'That didn’t work. Log in again.';

  /** Whether `error` is the limit's refusal ({@link TOO_MANY_ATTEMPTS}) — a page that shows no form line asks this. */
  static isTooManyAttempts(error: unknown): boolean {
    return error instanceof Error && error.message === AuthApi.TOO_MANY_ATTEMPTS;
  }

  /**
   * Signs up AND establishes the session in the same request (auto-login): on resolve the
   * caller navigates straight into the app — no bounce through the login form. Invited users
   * pass the invite `token` and no email (the invite carries it).
   */
  async signup(user: UserSignup, inviteToken?: string): Promise<void> {
    const response = await this.send(routes.signup.path, {
      method: routes.signup.method,
      body: JSON.stringify({ ...user, token: inviteToken }),
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status != 200) {
      throw new Error(await this.reason(response, `Failed to sign up, error: ${response.statusText}`));
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }
  }

  /**
   * The password step. Resolves with nothing when the session is open, and with the passkey step
   * when the door answers one in its place — no session exists then, and the page runs the step
   * (`answerPasskey`, `answerAddPasskey`).
   *
   * The door's answer is read by the one reader both steps share (`doorSays`), closed: an answer
   * that is neither is a sign-in that failed, and throws — the door's own line when the answer
   * carries one, else words of this class ({@link LOGIN_FAILED} for a 200, the status for
   * anything else). Never the words of an exception met while reading it.
   */
  async login(email: string, password: string): Promise<SignInSecondStep | undefined> {
    const response = await this.post({ email, password });
    const answer = await this.doorSays(response);
    if (answer.says === 'open') {
      return undefined;
    }
    if (answer.says === 'step') {
      return answer.secondStep;
    }

    const generic = response.status === 200 ? AuthApi.LOGIN_FAILED : `Failed to log in, error: ${response.statusText}`;
    throw new Error(answer.line ?? generic);
  }

  /** Answer the passkey step with the assertion the device's sheet gave. */
  async answerPasskey(assertion: PasskeyAssertion): Promise<SignInSecondStepAnswer> {
    return await this.answerSecondStep({ passkey: assertion });
  }

  /** Answer the add step with the registration of the account's first passkey. */
  async answerAddPasskey(registration: PasskeyRegistration): Promise<SignInSecondStepAnswer> {
    return await this.answerSecondStep({ addPasskey: registration });
  }

  /**
   * Resolves with the door's answer — the one sentence it gives for every address, with an
   * account or without — for the page to show as it is.
   */
  async initiatePasswordReset(email: string): Promise<string> {
    const response = await this.send(routes.initiatePasswordReset.path, {
      method: routes.initiatePasswordReset.method,
      body: JSON.stringify({ email }),
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status != 200) {
      throw new Error(`Failed to send the reset email. Please try again.`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(`Failed to send the reset email. Please try again.`);
    }

    return body.message;
  }

  /**
   * A valid token resolves with the account email the reset is for — the page renders it as
   * the read-only `autocomplete="username"` field so password managers can associate the
   * updated password with the stored credential. A check the limit refused throws
   * {@link TOO_MANY_ATTEMPTS}: the link was not judged, so it is no verdict on the link.
   */
  async validateResetToken(token: string): Promise<{ valid: true; email: string } | { valid: false; message: string }> {
    const response = await this.send(`${routes.validateResetToken.path}?token=${token}`, {
      method: routes.validateResetToken.method,
    });
    const body = await response.json();
    if (!body.isValid) {
      return { valid: false, message: body.message || 'Invalid or expired token' };
    }

    return { valid: true, email: body.email };
  }

  /**
   * Resolves on a reset; throws the door's own line otherwise — the route answers every refusal as
   * a 400 `{ error }` (a password the server's rules refuse, a link no longer live), and that line
   * is what the person needs to act on.
   */
  async executePasswordReset(token: string, newPassword: string): Promise<void> {
    const response = await this.send(routes.executePasswordReset.path, {
      method: routes.executePasswordReset.method,
      body: JSON.stringify({ token, newPassword }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status !== 200) {
      throw new Error(await this.reason(response, 'Failed to reset password'));
    }
  }

  /**
   * One answer to the passkey step, posted to the sign-in door itself — the step's cookie rides
   * the request and names its challenge; the body carries no address. The door answers one of
   * three shapes on a 200: `{}`, `{ error, secondStep }` or `{ error, restart: true }`.
   *
   * It is read by the one reader both steps share (`doorSays`), closed. The session is open
   * (`done`) on the door's own empty answer and on nothing else; an answer that carries a step the
   * page can run is that step (`again`); and everything else is the end of the step (`restart`) —
   * the door's restart, a line with nothing beside it, a 200 in no shape the door sends (nothing,
   * a list, a step of a kind this page cannot run), the limit in front of the door, a step that
   * failed on the server (answered by no JSON), a proxy's page. A request that never got an answer
   * at all (no network) is not an answer: it throws, as every other call here does, and the page
   * says so.
   */
  private async answerSecondStep(body: object): Promise<SignInSecondStepAnswer> {
    let response: Response;
    try {
      response = await this.post(body);
    } catch (error: unknown) {
      if (AuthApi.isTooManyAttempts(error)) {
        return { status: 'restart', line: AuthApi.TOO_MANY_ATTEMPTS };
      }
      throw error;
    }

    const answer = await this.doorSays(response);
    if (answer.says === 'open') {
      return { status: 'done' };
    }
    if (answer.says === 'step') {
      return { status: 'again', line: answer.line ?? AuthApi.STEP_OVER, secondStep: answer.secondStep };
    }

    return { status: 'restart', line: answer.line ?? AuthApi.STEP_OVER };
  }

  /**
   * The ONE reader of what an answer of the sign-in door says — the password step's and the
   * passkey step's alike, so "the session is open" has one meaning in this class. It is read
   * closed: the session is open on a 200 whose body is the door's own empty answer, `{}`, and on
   * nothing else; a 200 that carries a step the page can run is that step; and everything else is
   * neither — an answer that is not a 200, whatever its body; a body that is no JSON (a proxy's
   * page); nothing, a list, text; a step of a kind this page cannot run; an answer with anything
   * else in it. `line` is the door's own sentence when the answer carries one. What an answer with
   * none reads as is its asker's to say, in words of its own: nothing met while reading the answer
   * is thrown from here, so no exception's words reach the person.
   */
  private async doorSays(response: Response): Promise<SignInDoorAnswer> {
    let answer: any;
    try {
      answer = await response.json();
    } catch {
      return { says: 'neither' };
    }
    const line = this.lineOf(answer);
    if (response.status !== 200) {
      return { says: 'neither', line };
    }
    const secondStep = this.secondStepOf(answer);
    if (secondStep) {
      return { says: 'step', secondStep, line };
    }

    return this.isEmptyAnswer(answer) ? { says: 'open' } : { says: 'neither', line };
  }

  /** Whether `answer` is the door's own empty answer, `{}` — the one shape that says the session is open. */
  private isEmptyAnswer(answer: unknown): boolean {
    return typeof answer === 'object' && answer !== null && !Array.isArray(answer) && Object.keys(answer).length === 0;
  }

  /** The passkey step an answer of the door carries, when it carries one in the step's shape. */
  private secondStepOf(answer: any): SignInSecondStep | undefined {
    const step = answer?.secondStep;
    const known = step?.kind === 'passkey' || step?.kind === 'addPasskey';
    return known && typeof step.options === 'object' && step.options !== null ? step : undefined;
  }

  /** One request at the sign-in door. */
  private async post(body: object): Promise<Response> {
    return await this.send(routes.login.path, {
      method: routes.login.method,
      body: JSON.stringify(body),
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Every door's request — the ONE fetch in this class, so no door can skip the limit's read. A 429
   * is a per-address limit in front of the door: said in the throttle's words, before any body is
   * read (the limit's answer is the load balancer's page, never the door's JSON).
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(path, { ...init, credentials: 'same-origin' });
    if (response.status === 429) {
      throw new Error(AuthApi.TOO_MANY_ATTEMPTS);
    }

    return response;
  }

  /**
   * The line a refused request is told: the door's own `error` when the answer's body carries one
   * (a route refuses in user-readable words, on a 400 as on a 200), else `generic` — a body that is
   * no JSON (a proxy's error page) or carries no line.
   */
  private async reason(response: { json(): Promise<any> }, generic: string): Promise<string> {
    try {
      return this.lineOf(await response.json()) ?? generic;
    } catch {
      return generic;
    }
  }

  /** The door's own sentence in an answer's body, when it carries one that is not blank. */
  private lineOf(answer: any): string | undefined {
    const error = answer?.error;
    return typeof error === 'string' && error.trim() ? error : undefined;
  }
}
