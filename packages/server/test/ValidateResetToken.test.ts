import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { validateResetPasswordToken } from '../src/routes/validateResetPasswordToken';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * `GET /user/validate-reset-token`. Beyond the valid/expired/unknown verdicts, the valid
 * response carries the account EMAIL: the reset page renders it as the read-only
 * `autocomplete="username"` field so password managers can associate the updated password
 * with the stored credential. The email only ever rides a VALID token's response — the
 * token was delivered to that very inbox, so it reveals nothing the holder doesn't know —
 * while invalid/expired verdicts stay email-free (no account-probing oracle).
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

const armResetToken = async (email: string, token: string, expiration: moment.Moment) => {
  const user = await testEnv.createUser({ name: 'Reset User', email });
  await getDbAsSystem().update(tables.User, {
    id: user.id,
    passwordResetToken: token,
    passwordResetTokenExpiration: expiration,
  });
};

describe('validateResetPasswordToken route', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('a valid token resolves isValid WITH the account email (the reset form identifier)', async () => {
    await armResetToken('reset-valid@test.local', 'tok-valid-1', moment().add(1, 'hour'));

    const outcome = await invokeValidate({ token: 'tok-valid-1' });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ isValid: true, email: 'reset-valid@test.local' });
  });

  it('an expired token resolves invalid and leaks no email', async () => {
    await armResetToken('reset-expired@test.local', 'tok-expired-1', moment().subtract(1, 'minute'));

    const outcome = await invokeValidate({ token: 'tok-expired-1' });

    expect(outcome.status).toBe(200);
    expect(outcome.body.isValid).toBe(false);
    expect(outcome.body.email).toBeUndefined();
  });

  it('an unknown token resolves invalid and leaks no email', async () => {
    const outcome = await invokeValidate({ token: 'tok-never-issued' });

    expect(outcome.status).toBe(200);
    expect(outcome.body.isValid).toBe(false);
    expect(outcome.body.email).toBeUndefined();
  });

  it('a missing token is a 400', async () => {
    const outcome = await invokeValidate({});

    expect(outcome.status).toBe(400);
    expect(outcome.body.isValid).toBe(false);
  });
});
