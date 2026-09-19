import moment, { Moment } from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { tables, User } from '@proteinjs/user';
import { executePasswordReset } from '../src/routes/executePasswordReset';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { PasswordResetToken } from '../src/authentication/PasswordResetToken';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * `POST /user/execute-password-reset`. The token is the only credential this route accepts, so
 * the lookup must never be built from anything but a well-formed token: a `null` in the body
 * renders as `IS NULL` and matches every account with no pending reset, an empty string matches
 * an emptied column, and other types reach the driver. Covered here, outcomes only (rows
 * written), against the Spanner emulator:
 * - an absent, null, empty or malformed token: 400, and no password in the table changes — an
 *   account with no pending reset is never matched, whatever the request carries;
 * - a live token resets the password once: the row verifies the new password, the token and its
 *   expiry are cleared, and the same token presented again is refused;
 * - an expired token, or a token whose row carries no expiry, is refused;
 * - a blank new password is refused without consuming the token;
 * - the presented token never reaches the log;
 * - the token owner's own contract: mint shape, the stored-vs-presented match, liveness, and the
 *   conditional redemption.
 */

type RouteOutcome = { status: number; body?: any };

const invokeExecute = async (body: Record<string, unknown>): Promise<RouteOutcome> => {
  const outcome: RouteOutcome = { status: 200 };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body;
    },
  };
  await executePasswordReset.onRequest({ body } as never, response as never);
  return outcome;
};

const mintToken = () => new PasswordResetToken().mint();

const armResetToken = async (email: string, token: string | null, expiration: Moment | null): Promise<User> => {
  const user = await testEnv.createUser({ name: 'Reset User', email });
  await getDbAsSystem().update(tables.User, {
    id: user.id,
    passwordResetToken: token,
    passwordResetTokenExpiration: expiration,
  });
  return user;
};

const userRow = async (id: string) => await getDbAsSystem().get(tables.User, { id });

/** Every password in the table, by email — the whole-table outcome a refused request must leave untouched. */
const passwordsByEmail = async (): Promise<Record<string, string>> => {
  const byEmail: Record<string, string> = {};
  for (const user of await getDbAsSystem().query(tables.User, {})) {
    byEmail[user.email] = user.password;
  }
  return byEmail;
};

type TokenInternals = {
  matches(stored: string | null | undefined, presented: string): boolean;
  isLive(expiration: Moment | null | undefined): boolean;
};

describe('executePasswordReset route', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
    // No pending reset — the account a `null` token's `IS NULL` filter would match.
    await testEnv.createUser({ name: 'Idle User', email: 'reset-idle@test.local' });
    // An emptied token column — the account an empty token would match.
    await armResetToken('reset-emptied@test.local', '', moment().add(1, 'hour'));
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  describe('a request without a well-formed token is refused before any lookup', () => {
    it.each([
      ['absent', {}],
      ['null', { token: null }],
      ['empty', { token: '' }],
      ['not a token string', { token: 'tok-valid-1' }],
      ['a number', { token: 123 }],
      ['an array', { token: ['a', 'b'] }],
      ['an object', { token: { passwordResetToken: null } }],
    ])('%s: 400, and no password in the table changes', async (_label, tokenField) => {
      const before = await passwordsByEmail();

      const outcome = await invokeExecute({ ...tokenField, newPassword: 'hijacked' });

      expect(outcome.status).toBe(400);
      expect(outcome.body).toEqual({ error: 'Invalid or expired reset token' });
      expect(await passwordsByEmail()).toEqual(before);
    });
  });

  it('a live token resets the password once: the row verifies it, the token clears, a re-presentation is refused', async () => {
    const token = mintToken();
    const user = await armResetToken('reset-live@test.local', token, moment().add(1, 'hour'));

    const first = await invokeExecute({ token, newPassword: 'first new password' });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ message: 'Password has been successfully reset' });
    const afterFirst = await userRow(user.id);
    await expect(new PasswordHasher().verify(afterFirst.password, 'first new password')).resolves.toBe(true);
    expect(afterFirst.passwordResetToken).toBeNull();
    expect(afterFirst.passwordResetTokenExpiration).toBeNull();

    const second = await invokeExecute({ token, newPassword: 'second new password' });

    expect(second.status).toBe(400);
    expect((await userRow(user.id)).password).toBe(afterFirst.password);
  });

  it('an expired token is refused and changes nothing', async () => {
    const token = mintToken();
    const user = await armResetToken('reset-expired@test.local', token, moment().subtract(1, 'minute'));
    const before = (await userRow(user.id)).password;

    const outcome = await invokeExecute({ token, newPassword: 'hijacked' });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toEqual({ error: 'Reset token has expired' });
    const row = await userRow(user.id);
    expect(row.password).toBe(before);
    expect(row.passwordResetToken).toBe(token);
  });

  it('a token whose row carries no expiry is refused — never live by omission', async () => {
    const token = mintToken();
    const user = await armResetToken('reset-no-expiry@test.local', token, null);
    const before = (await userRow(user.id)).password;

    const outcome = await invokeExecute({ token, newPassword: 'hijacked' });

    expect(outcome.status).toBe(400);
    expect((await userRow(user.id)).password).toBe(before);
  });

  it('a blank new password is refused without consuming the token', async () => {
    const token = mintToken();
    const user = await armResetToken('reset-blank@test.local', token, moment().add(1, 'hour'));
    const before = (await userRow(user.id)).password;

    for (const newPassword of ['', undefined, 42]) {
      const outcome = await invokeExecute({ token, newPassword });
      expect(outcome.status).toBe(400);
    }

    const row = await userRow(user.id);
    expect(row.password).toBe(before);
    expect(row.passwordResetToken).toBe(token);
  });

  it('the presented token never reaches the log', async () => {
    const token = mintToken(); // well-formed, never issued
    const info = jest.spyOn(Logger.prototype, 'info');
    try {
      await invokeExecute({ token, newPassword: 'hijacked' });

      expect(info).toHaveBeenCalled();
      for (const [entry] of info.mock.calls) {
        expect(JSON.stringify(entry)).not.toContain(token);
      }
    } finally {
      info.mockRestore();
    }
  });

  describe('PasswordResetToken', () => {
    const internals = new PasswordResetToken() as unknown as TokenInternals;

    it('mints 64 lowercase hex characters, fresh each time', () => {
      const token = mintToken();

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(mintToken()).not.toBe(token);
    });

    it('a stored token matches only the same string — never an absent or emptied one', () => {
      const token = mintToken();

      expect(internals.matches(token, token)).toBe(true);
      expect(internals.matches(mintToken(), token)).toBe(false);
      expect(internals.matches(null, token)).toBe(false);
      expect(internals.matches(undefined, token)).toBe(false);
      expect(internals.matches('', token)).toBe(false);
    });

    it('an expiry is live only as a valid timestamp in the future', () => {
      expect(internals.isLive(moment().add(1, 'minute'))).toBe(true);
      expect(internals.isLive(moment().subtract(1, 'minute'))).toBe(false);
      expect(internals.isLive(null)).toBe(false);
      expect(internals.isLive(undefined)).toBe(false);
      expect(internals.isLive(moment.invalid())).toBe(false);
    });

    it('redeem writes only while the row still carries the token', async () => {
      const live = mintToken();
      const user = await armResetToken('reset-redeem@test.local', live, moment().add(1, 'hour'));
      const before = (await userRow(user.id)).password;

      await expect(new PasswordResetToken().redeem(user, mintToken(), 'other-hash')).resolves.toBe(false);
      expect((await userRow(user.id)).password).toBe(before);

      await expect(new PasswordResetToken().redeem(user, live, 'new-hash')).resolves.toBe(true);
      const row = await userRow(user.id);
      expect(row.password).toBe('new-hash');
      expect(row.passwordResetToken).toBeNull();
      expect(row.passwordResetTokenExpiration).toBeNull();
    });
  });
});
