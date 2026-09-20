import { createHash } from 'crypto';
import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { validateResetPasswordToken } from '../src/routes/validateResetPasswordToken';
import { PasswordResetToken } from '../src/authentication/PasswordResetToken';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { DbTraffic } from './DbTraffic';
import { LogCapture } from './LogCapture';
import { MalformedResetTokens } from './MalformedResetTokens';

const testEnv = new UserServerTestEnvironment();

/**
 * `GET /user/validate-reset-token`. Beyond the valid/expired/unknown verdicts, the valid
 * response carries the account EMAIL: the reset page renders it as the read-only
 * `autocomplete="username"` field so password managers can associate the updated password
 * with the stored credential. The email only ever rides a VALID token's response — the
 * token was delivered to that very inbox, so it reveals nothing the holder doesn't know —
 * while invalid/expired verdicts stay email-free (no account-probing oracle). A query value
 * that is not a well-formed token — every type a parsed query string can deliver, and every
 * near-miss cut from a live token — is invalid without a lookup: nothing reaches the database
 * (no lookup built, no statement run), which the verdict alone could not prove, since a wrongly
 * admitted value still matches no row. The row stores the token's SHA-256 digest, never the
 * token: the stored digest presented as a token is invalid — it has a token's shape, so the one
 * lookup it builds is by the digest OF the presented value — and so is a token an earlier
 * release stored in clear. No token, no leading characters of one and no full digest reach the
 * log. Live tokens are seeded through `PasswordResetToken.mint`, so the suite moves with what
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

    const { result: outcome, traffic } = await DbTraffic.during(
      testEnv.spannerDriver,
      async () => await invokeValidate({ token: row.passwordResetToken })
    );

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ isValid: false, message: 'Invalid token' });
    expect(traffic.lookups).toEqual([{ passwordResetToken: sha256Hex(sha256Hex(token)) }]);
    expect(traffic.statements).toBe(1);
    expect(traffic.writes).toBe(0);
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

  describe('a query without a well-formed token is invalid without a lookup', () => {
    let liveToken: string;

    beforeAll(async () => {
      liveToken = await armResetToken('reset-shapes@test.local');
    });

    it.each(MalformedResetTokens.CASES)(
      '%s: invalid, no email, and nothing reaches the database',
      async (_label, tokenField) => {
        const query = tokenField(liveToken);

        const { result: outcome, traffic } = await DbTraffic.during(
          testEnv.spannerDriver,
          async () => await invokeValidate(query)
        );

        // Nothing usable in the query is a 400; anything else that is not a token is an invalid token.
        expect(outcome).toEqual(
          query.token
            ? { status: 200, body: { isValid: false, message: 'Invalid token' } }
            : { status: 400, body: { isValid: false, message: 'No token provided' } }
        );
        expect(traffic).toEqual(DbTraffic.NONE);
      }
    );

    it('after every refusal the live token is still valid', async () => {
      const outcome = await invokeValidate({ token: liveToken });

      expect(outcome.body).toEqual({ isValid: true, email: 'reset-shapes@test.local' });
    });
  });

  it('no token, no leading characters of one and no full digest reach the log — every verdict', async () => {
    const live = await armResetToken('reset-log-live@test.local');
    const expired = await armResetToken('reset-log-expired@test.local', moment().subtract(1, 'minute'));
    const unissued = unissuedToken();

    const log = await LogCapture.during(async () => {
      await invokeValidate({ token: unissued });
      await invokeValidate({ token: live.toUpperCase() });
      await invokeValidate({ token: sha256Hex(live) });
      await invokeValidate({ token: expired });
      await invokeValidate({ token: live });
    });

    // The capture saw the route's lines: the refusals above logged.
    expect(log.text).toContain('Invalid reset token used');
    expect(log.text).toContain('Expired reset token used');
    expect(log.lines.length).toBeGreaterThanOrEqual(4);
    // The digest presented as a token is covered by `live`: its full digest is what was presented.
    for (const token of [unissued, live, expired]) {
      log.expectFreeOf(token);
    }
  });
});
