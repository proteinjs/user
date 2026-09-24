import { UserSignup, routes } from '@proteinjs/user';

/**
 * The auth flows' server calls, in one place so the pages hold presentation only.
 * Methods resolve on success and throw an `Error` whose message is user-readable.
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
   * Signs up AND establishes the session in the same request (auto-login): on resolve the
   * caller navigates straight into the app — no bounce through the login form. Invited users
   * pass the invite `token` and no email (the invite carries it).
   */
  async signup(user: UserSignup, inviteToken?: string): Promise<void> {
    const response = await fetch(routes.signup.path, {
      method: routes.signup.method,
      body: JSON.stringify({ ...user, token: inviteToken }),
      redirect: 'follow',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    this.refuseIfLimited(response);
    if (response.status != 200) {
      throw new Error(`Failed to sign up, error: ${response.statusText}`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }
  }

  async login(email: string, password: string): Promise<void> {
    const response = await fetch(routes.login.path, {
      method: routes.login.method,
      body: JSON.stringify({ email, password }),
      redirect: 'follow',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    this.refuseIfLimited(response);
    if (response.status != 200) {
      throw new Error(`Failed to log in, error: ${response.statusText}`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }
  }

  /**
   * Resolves with the door's answer — the one sentence it gives for every address, with an
   * account or without — for the page to show as it is.
   */
  async initiatePasswordReset(email: string): Promise<string> {
    const response = await fetch(routes.initiatePasswordReset.path, {
      method: routes.initiatePasswordReset.method,
      body: JSON.stringify({ email }),
      redirect: 'follow',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    this.refuseIfLimited(response);
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
   * updated password with the stored credential.
   */
  async validateResetToken(token: string): Promise<{ valid: true; email: string } | { valid: false; message: string }> {
    const response = await fetch(`${routes.validateResetToken.path}?token=${token}`, {
      method: routes.validateResetToken.method,
      credentials: 'same-origin',
    });
    const body = await response.json();
    if (!body.isValid) {
      return { valid: false, message: body.message || 'Invalid or expired token' };
    }

    return { valid: true, email: body.email };
  }

  async executePasswordReset(token: string, newPassword: string): Promise<void> {
    const response = await fetch(routes.executePasswordReset.path, {
      method: routes.executePasswordReset.method,
      body: JSON.stringify({ token, newPassword }),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status !== 200) {
      throw new Error('Failed to reset password');
    }
  }

  /** A 429 is a per-address limit in front of the door: say so in the throttle's words. */
  private refuseIfLimited(response: { status: number }): void {
    if (response.status === 429) {
      throw new Error(AuthApi.TOO_MANY_ATTEMPTS);
    }
  }
}
