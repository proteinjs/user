import { AuthApi } from '../src/auth/AuthApi';
import { routes } from '@proteinjs/user';

function mockFetch(response: { status?: number; statusText?: string; body?: any }) {
  const fetchMock = jest.fn().mockResolvedValue({
    status: response.status ?? 200,
    statusText: response.statusText ?? 'OK',
    json: async () => response.body ?? {},
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

  it('throws on a non-200 response', async () => {
    mockFetch({ status: 401, statusText: 'Unauthorized' });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow('Unauthorized');
  });

  it('throws the server-provided error from a 200 response body', async () => {
    mockFetch({ body: { error: 'Incorrect email or password' } });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow('Incorrect email or password');
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

  it('throws on a non-200 response', async () => {
    mockFetch({ status: 400 });
    await expect(new AuthApi().executePasswordReset('tok', 'hunter22')).rejects.toThrow('Failed to reset password');
  });
});
