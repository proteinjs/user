import { AuthApi } from '../src/auth/AuthApi';
import { routes } from '@proteinjs/user';

function mockFetch(response: { status?: number; statusText?: string; body?: any; notJson?: boolean }) {
  const fetchMock = jest.fn().mockResolvedValue({
    status: response.status ?? 200,
    statusText: response.statusText ?? 'OK',
    json: async () => {
      if (response.notJson) {
        throw new SyntaxError('Unexpected token < in JSON');
      }
      return response.body ?? {};
    },
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

afterEach(() => {
  delete (global as any).fetch;
});

describe('AuthApi.login', () => {
  it('posts the credentials to the login route and resolves on success', async () => {
    const fetchMock = mockFetch({ body: {} });
    await new AuthApi().login('ada@example.com', 'hunter22');
    expect(fetchMock).toHaveBeenCalledWith(
      routes.login.path,
      expect.objectContaining({
        method: routes.login.method,
        body: JSON.stringify({ email: 'ada@example.com', password: 'hunter22' }),
      })
    );
  });

  it("a refused sign-in throws the door's own line, whatever its status — the generic words only when the body carries none", async () => {
    mockFetch({ status: 401, statusText: 'Unauthorized', body: { error: 'Incorrect email or password' } });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow('Incorrect email or password');

    mockFetch({ status: 401, statusText: 'Unauthorized' });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow(
      'Failed to log in, error: Unauthorized'
    );
  });

  it('throws the server-provided error from a 200 response body', async () => {
    mockFetch({ body: { error: 'Incorrect email or password' } });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow('Incorrect email or password');
  });
});

/**
 * The door's own line reaches the person on every password road. A route refuses in user-readable
 * words — `{ error }` on a 400 as on a 200 (the reset's redeem answers 400 for a password the
 * server's rules refuse: "That password is too common", and for a link no longer live) — and the
 * api throws THAT line; the generic words stand only for an answer with no line in it.
 */
describe("AuthApi — a refusal's own line is what the form is told", () => {
  it("sign-up: a refused answer's line, whatever its status", async () => {
    mockFetch({ status: 400, statusText: 'Bad Request', body: { error: 'Use at least 8 characters' } });
    await expect(new AuthApi().signup({ name: 'Ada', email: 'ada@example.com', password: 'short' })).rejects.toThrow(
      'Use at least 8 characters'
    );
  });

  it("the password reset: the route's 400 carries the server's rule — the person reads the rule, not a generic failure", async () => {
    mockFetch({ status: 400, statusText: 'Bad Request', body: { error: 'That password is too common' } });
    await expect(new AuthApi().executePasswordReset('tok', 'password1')).rejects.toThrow('That password is too common');
  });

  it('the password reset: a link no longer live reads as the route says it', async () => {
    mockFetch({ status: 400, body: { error: 'Reset token has expired' } });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(
      'Reset token has expired'
    );
  });

  it('an answer with no line in it falls back to the generic words — an empty body, or one that is no JSON at all', async () => {
    mockFetch({ status: 502, statusText: 'Bad Gateway', body: {} });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(
      'Failed to reset password'
    );
    mockFetch({ status: 502, statusText: 'Bad Gateway', notJson: true });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(
      'Failed to reset password'
    );
    mockFetch({ status: 502, statusText: 'Bad Gateway', notJson: true });
    await expect(
      new AuthApi().signup({ name: 'Ada', email: 'ada@example.com', password: 'hunter22x' })
    ).rejects.toThrow('Failed to sign up, error: Bad Gateway');
  });
});

describe('AuthApi.initiatePasswordReset', () => {
  it('posts the email and resolves on success', async () => {
    const fetchMock = mockFetch({ body: {} });
    await new AuthApi().initiatePasswordReset('ada@example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      routes.initiatePasswordReset.path,
      expect.objectContaining({
        method: routes.initiatePasswordReset.method,
        body: JSON.stringify({ email: 'ada@example.com' }),
      })
    );
  });

  it("resolves with the door's answer — the one sentence it gives for every address", async () => {
    mockFetch({ body: { message: 'If that address has an account, a reset link is on its way.' } });
    await expect(new AuthApi().initiatePasswordReset('ada@example.com')).resolves.toBe(
      'If that address has an account, a reset link is on its way.'
    );
  });

  it('throws a user-readable error on failure', async () => {
    mockFetch({ status: 500, statusText: 'Internal Server Error' });
    await expect(new AuthApi().initiatePasswordReset('ada@example.com')).rejects.toThrow(
      'Failed to send the reset email. Please try again.'
    );
  });
});

describe('AuthApi.validateResetToken', () => {
  it('resolves valid WITH the account email the reset is for (the form renders it as the identifier)', async () => {
    mockFetch({ body: { isValid: true, email: 'ada@example.com' } });
    await expect(new AuthApi().validateResetToken('tok')).resolves.toEqual({
      valid: true,
      email: 'ada@example.com',
    });
  });

  it('resolves invalid with the server message', async () => {
    mockFetch({ body: { isValid: false, message: 'Token expired' } });
    await expect(new AuthApi().validateResetToken('tok')).resolves.toEqual({
      valid: false,
      message: 'Token expired',
    });
  });

  it('falls back to a generic message when the server sends none', async () => {
    mockFetch({ body: { isValid: false } });
    await expect(new AuthApi().validateResetToken('tok')).resolves.toEqual({
      valid: false,
      message: 'Invalid or expired token',
    });
  });
});

describe('AuthApi.executePasswordReset', () => {
  it('posts the token and new password', async () => {
    const fetchMock = mockFetch({ body: {} });
    await new AuthApi().executePasswordReset('tok', 'hunter22');
    expect(fetchMock).toHaveBeenCalledWith(
      routes.executePasswordReset.path,
      expect.objectContaining({
        method: routes.executePasswordReset.method,
        body: JSON.stringify({ token: 'tok', newPassword: 'hunter22' }),
      })
    );
  });

  it('throws the generic words on a non-200 response that carries no line', async () => {
    mockFetch({ status: 400 });
    await expect(new AuthApi().executePasswordReset('tok', 'hunter22')).rejects.toThrow('Failed to reset password');
  });
});

/**
 * A 429 on the sign-in, sign-up and reset doors is a per-address limit in FRONT of the server (the
 * load balancer's rate-based ban): no body the form can read, and over HTTP/2 no status text either
 * (`statusText` is ''), so the old reading showed "Failed to log in, error: " and nothing after it.
 * The forms say what the doors' own throttles say instead.
 */
describe('AuthApi — a 429 from in front of the door reads as the throttle answer', () => {
  const TOO_MANY = 'Too many attempts. Try again in a few minutes.';

  it('sign-in', async () => {
    mockFetch({ status: 429, statusText: '' });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow(TOO_MANY);
  });

  it('sign-up', async () => {
    mockFetch({ status: 429, statusText: '' });
    await expect(new AuthApi().signup({ name: 'Ada', email: 'ada@example.com', password: 'hunter22' })).rejects.toThrow(
      TOO_MANY
    );
  });

  it('the password reset request', async () => {
    mockFetch({ status: 429, statusText: '' });
    await expect(new AuthApi().initiatePasswordReset('ada@example.com')).rejects.toThrow(TOO_MANY);
  });

  // The ban's answer is the load balancer's page, not the door's JSON — the reset link's two doors
  // read the status before any body, as the others do.
  it('the reset link check', async () => {
    mockFetch({ status: 429, statusText: '', notJson: true });
    await expect(new AuthApi().validateResetToken('tok')).rejects.toThrow(TOO_MANY);
  });

  it('the password reset', async () => {
    mockFetch({ status: 429, statusText: '', notJson: true });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(TOO_MANY);
  });
});
