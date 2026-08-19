import { UserSignup, routes } from '@proteinjs/user';

/**
 * The auth flows' server calls, in one place so the pages hold presentation only.
 * Methods resolve on success and throw an `Error` whose message is user-readable.
 */
export class AuthApi {
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
    if (response.status != 200) {
      throw new Error(`Failed to log in, error: ${response.statusText}`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }
  }

  async initiatePasswordReset(email: string): Promise<void> {
    const response = await fetch(routes.initiatePasswordReset.path, {
      method: routes.initiatePasswordReset.method,
      body: JSON.stringify({ email }),
      redirect: 'follow',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status != 200) {
      throw new Error(`Failed to send the reset email. Please try again.`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(`Failed to send the reset email. Please try again.`);
    }
  }

  /** Resolves with an error message when the token is invalid; undefined when it's valid. */
  async validateResetToken(token: string): Promise<string | undefined> {
    const response = await fetch(`${routes.validateResetToken.path}?token=${token}`, {
      method: routes.validateResetToken.method,
      credentials: 'same-origin',
    });
    const body = await response.json();
    if (!body.isValid) {
      return body.message || 'Invalid or expired token';
    }
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
}
