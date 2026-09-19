import { createHash } from 'crypto';
import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { validateResetPasswordToken } from '../src/routes/validateResetPasswordToken';
import { PasswordResetToken } from '../src/authentication/PasswordResetToken';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * `GET /user/validate-reset-token`. Beyond the valid/expired/unknown verdicts, the valid
 * response carries the account EMAIL: the reset page renders it as the read-only
 * `autocomplete="username"` field so password managers can associate the updated password
 * with the stored credential. The email only ever rides a VALID token's response — the
 * token was delivered to that very inbox, so it reveals nothing the holder doesn't know —
 * while invalid/expired verdicts stay email-free (no account-probing oracle). A query value
 * that is not a well-formed token (a parsed object or array, a string of another shape) is
 * invalid without a lookup. The row stores the token's SHA-256 digest, never the token: the
 * stored digest presented as a token is invalid, and so is a token an earlier release stored in
 * clear. Live tokens are seeded through `PasswordResetToken.mint`, so the suite moves with what
 * the owner stores.
 */

type RouteOutcome = { status?: number; body?: any };

const invokeValidate = async (query: Record<string, unknown>): Promise<RouteOutcome> => {
  const outcome: RouteOutcome = {};
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body;
    },
  };
  await validateResetPasswordToken.onRequest({ query } as never, response as never);
  return outcome;
};

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** A well-formed token that was never issued to anyone. */
const unissuedToken = () => sha256Hex(`never issued ${Math.random()}`);

/** A user with a token minted by the owner; `expiration` (when given) replaces the expiry the mint stored. */
const armResetToken = async (email: string, expiration?: moment.Moment): Promise<string> => {
  const user = await testEnv.createUser({ name: 'Reset User', email });
  const token = await new PasswordResetToken().mint(user);
  if (expiration !== undefined) {
    await getDbAsSystem().update(tables.User, { id: user.id, passwordResetTokenExpiration: expiration });
  }
  return token;
};

describe('validateResetPasswordToken route', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('a valid token resolves isValid WITH the account email (the reset form identifier)', async () => {
    const token = await armResetToken('reset-valid@test.local');

    const outcome = await invokeValidate({ token });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ isValid: true, email: 'reset-valid@test.local' });
  });

  it('an expired token resolves invalid and leaks no email', async () => {
    const token = await armResetToken('reset-expired@test.local', moment().subtract(1, 'minute'));

    const outcome = await invokeValidate({ token });

    expect(outcome.status).toBe(200);
    expect(outcome.body.isValid).toBe(false);
    expect(outcome.body.email).toBeUndefined();
  });

  it('an unknown token resolves invalid and leaks no email', async () => {
    const outcome = await invokeValidate({ token: unissuedToken() });

    expect(outcome.status).toBe(200);
    expect(outcome.body.isValid).toBe(false);
    expect(outcome.body.email).toBeUndefined();
  });

  it('the stored digest presented as a token resolves invalid — the row holds nothing that can be presented', async () => {
    const token = await armResetToken('reset-digest@test.local');
    const row = await getDbAsSystem().get(tables.User, { email: 'reset-digest@test.local' });
    expect(row.passwordResetToken).toBe(sha256Hex(token));

    const outcome = await invokeValidate({ token: row.passwordResetToken });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ isValid: false, message: 'Invalid token' });
  });

  it('a token an earlier release stored in clear resolves invalid — no migration, the person asks again', async () => {
    const clearToken = unissuedToken();
    const user = await testEnv.createUser({ name: 'Reset User', email: 'reset-stored-in-clear@test.local' });
    await getDbAsSystem().update(tables.User, {
      id: user.id,
      passwordResetToken: clearToken,
      passwordResetTokenExpiration: moment().add(1, 'hour'),
    });

    const outcome = await invokeValidate({ token: clearToken });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ isValid: false, message: 'Invalid token' });
  });

  it.each([
    ['a string of another shape', 'tok-never-issued'],
    ['a parsed array', ['a', 'b']],
    ['a parsed object', { passwordResetToken: null }],
  ])('%s resolves invalid without a lookup and leaks no email', async (_label, token) => {
    const outcome = await invokeValidate({ token });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ isValid: false, message: 'Invalid token' });
  });

  it('a missing token is a 400', async () => {
    const outcome = await invokeValidate({});

    expect(outcome.status).toBe(400);
    expect(outcome.body.isValid).toBe(false);
  });
});
