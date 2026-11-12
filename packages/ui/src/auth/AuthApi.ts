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
   */
  async login(email: string, password: string): Promise<SignInSecondStep | undefined> {
    const response = await this.post({ email, password });
    if (response.status != 200) {
      throw new Error(await this.reason(response, `Failed to log in, error: ${response.statusText}`));
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }

    return this.secondStepOf(body);
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
   * three shapes on a 200: `{}`, `{ error, secondStep }` or `{ error, restart: true }`. Anything
   * else — the limit in front of the door, a step that failed on the server (answered by no JSON),
   * a proxy's page — means the step is over, and reads as restart.
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
    if (response.status !== 200) {
      return { status: 'restart', line: await this.reason(response, AuthApi.STEP_OVER) };
    }

    let answer: any;
    try {
      answer = await response.json();
    } catch {
      return { status: 'restart', line: AuthApi.STEP_OVER };
    }
    const line = typeof answer?.error === 'string' && answer.error.trim() ? answer.error : undefined;
    const secondStep = this.secondStepOf(answer);
    if (secondStep) {
      return { status: 'again', line: line ?? AuthApi.STEP_OVER, secondStep };
    }
    if (line || answer?.restart) {
      return { status: 'restart', line: line ?? AuthApi.STEP_OVER };
    }

    return { status: 'done' };
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
      const error = (await response.json())?.error;
      return typeof error === 'string' && error.trim() ? error : generic;
    } catch {
      return generic;
    }
  }
}
