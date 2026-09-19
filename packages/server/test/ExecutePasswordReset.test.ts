import { createHash } from 'crypto';
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
 * - a request with no body at all: 400, and nothing changes;
 * - the row stores the token's SHA-256 digest, never the token: the stored digest presented as
 *   a token is refused, and so is a token an earlier release stored in clear;
 * - a live token resets the password once: the row verifies the new password, the token and its
 *   expiry are cleared, and the same token presented again is refused;
 * - an expired token, or a token whose row carries no expiry, is refused;
 * - a blank new password is refused without consuming the token;
 * - the presented token never reaches the log;
 * - the token owner's own contract: mint shape and what it stores, the stored-vs-presented
 *   digest match, liveness, the conditional redemption, the withdrawal, and the mint time.
 *
 * Every live token is seeded through `PasswordResetToken.mint`, so the suite moves with what the
 * owner stores. Only the two named column states the owner never writes are seeded raw: an
 * emptied column, and a token stored in clear by a release that predates the digest.
 */

type RouteOutcome = { status: number; body?: any };

const invokeExecuteRequest = async (request: Record<string, unknown>): Promise<RouteOutcome> => {
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
  await executePasswordReset.onRequest(request as never, response as never);
  return outcome;
};

const invokeExecute = async (body: Record<string, unknown>) => await invokeExecuteRequest({ body });

/** The digest a row must hold for `token`, computed here independently of the owner. */
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** A well-formed token that was never issued to anyone. */
const unissuedToken = () => sha256Hex(`never issued ${Math.random()}`);

/** A user with a token minted by the owner; `expiration` (when given) replaces the expiry the mint stored. */
const armResetToken = async (email: string, expiration?: Moment | null): Promise<{ user: User; token: string }> => {
  const user = await testEnv.createUser({ name: 'Reset User', email });
  const token = await new PasswordResetToken().mint(user);
  if (expiration !== undefined) {
    await getDbAsSystem().update(tables.User, { id: user.id, passwordResetTokenExpiration: expiration });
  }
  return { user, token };
};

/** A user whose token column is written raw — only for the column states the owner never writes. */
const armRawTokenColumn = async (email: string, stored: string): Promise<User> => {
  const user = await testEnv.createUser({ name: 'Reset User', email });
  await getDbAsSystem().update(tables.User, {
    id: user.id,
    passwordResetToken: stored,
    passwordResetTokenExpiration: moment().add(1, 'hour'),
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
  digest(token: string): string;
  matches(storedDigest: string | null | undefined, presentedDigest: string): boolean;
  isLive(expiration: Moment | null | undefined): boolean;
};

describe('executePasswordReset route', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
    // No pending reset — the account a `null` token's `IS NULL` filter would match.
    await testEnv.createUser({ name: 'Idle User', email: 'reset-idle@test.local' });
    // An emptied token column — the account an empty token would match.
    await armRawTokenColumn('reset-emptied@test.local', '');
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

  it.each([
    ['no body', 'reset-no-body@test.local', {}],
    ['a null body', 'reset-null-body@test.local', { body: null }],
  ])('a request with %s: 400, and nothing changes', async (_label, email, request) => {
    const { user, token } = await armResetToken(email);
    const before = await passwordsByEmail();

    const outcome = await invokeExecuteRequest(request);

    expect(outcome.status).toBe(400);
    expect(await passwordsByEmail()).toEqual(before);
    expect((await userRow(user.id)).passwordResetToken).toBe(sha256Hex(token));
  });

  it('a live token resets the password once: the row verifies it, the token clears, a re-presentation is refused', async () => {
    const { user, token } = await armResetToken('reset-live@test.local');

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

  it('the row stores the SHA-256 digest of the token, never the token — and the digest presented as a token is refused', async () => {
    const { user, token } = await armResetToken('reset-digest@test.local');
    const armed = await userRow(user.id);

    expect(armed.passwordResetToken).toBe(sha256Hex(token));
    expect(JSON.stringify(armed)).not.toContain(token);

    const outcome = await invokeExecute({ token: armed.passwordResetToken, newPassword: 'hijacked' });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toEqual({ error: 'Invalid or expired reset token' });
    const row = await userRow(user.id);
    expect(row.password).toBe(armed.password);
    expect(row.passwordResetToken).toBe(sha256Hex(token));
  });

  it('a token an earlier release stored in clear is refused — it fails for the rest of its hour, no migration', async () => {
    const clearToken = unissuedToken();
    const user = await armRawTokenColumn('reset-stored-in-clear@test.local', clearToken);
    const before = (await userRow(user.id)).password;

    const outcome = await invokeExecute({ token: clearToken, newPassword: 'hijacked' });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toEqual({ error: 'Invalid or expired reset token' });
    expect((await userRow(user.id)).password).toBe(before);
  });

  it('an expired token is refused and changes nothing', async () => {
    const { user, token } = await armResetToken('reset-expired@test.local', moment().subtract(1, 'minute'));
    const before = (await userRow(user.id)).password;

    const outcome = await invokeExecute({ token, newPassword: 'hijacked' });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toEqual({ error: 'Reset token has expired' });
    const row = await userRow(user.id);
    expect(row.password).toBe(before);
    expect(row.passwordResetToken).toBe(sha256Hex(token));
  });

  it('a token whose row carries no expiry is refused — never live by omission', async () => {
    const { user, token } = await armResetToken('reset-no-expiry@test.local', null);
    const before = (await userRow(user.id)).password;

    const outcome = await invokeExecute({ token, newPassword: 'hijacked' });

    expect(outcome.status).toBe(400);
    expect((await userRow(user.id)).password).toBe(before);
  });

  it('a blank new password is refused without consuming the token', async () => {
    const { user, token } = await armResetToken('reset-blank@test.local');
    const before = (await userRow(user.id)).password;

    for (const newPassword of ['', undefined, 42]) {
      const outcome = await invokeExecute({ token, newPassword });
      expect(outcome.status).toBe(400);
    }

    const row = await userRow(user.id);
    expect(row.password).toBe(before);
    expect(row.passwordResetToken).toBe(sha256Hex(token));
  });

  it('the presented token never reaches the log', async () => {
    const token = unissuedToken();
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

    it('mints 64 lowercase hex characters, fresh each time, and stores the digest with an expiry an hour out', async () => {
      const user = await testEnv.createUser({ name: 'Reset User', email: 'reset-mint@test.local' });

      const first = await new PasswordResetToken().mint(user);
      const afterFirst = await userRow(user.id);
      const second = await new PasswordResetToken().mint(user);
      const afterSecond = await userRow(user.id);

      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toMatch(/^[0-9a-f]{64}$/);
      expect(second).not.toBe(first);
      expect(afterFirst.passwordResetToken).toBe(sha256Hex(first));
      expect(afterSecond.passwordResetToken).toBe(sha256Hex(second));
      const minutesOut = moment(afterSecond.passwordResetTokenExpiration).diff(moment(), 'minutes', true);
      expect(minutesOut).toBeGreaterThan(59);
      expect(minutesOut).toBeLessThanOrEqual(60);
    });

    it('the digest is the SHA-256 of the token, hex-encoded', () => {
      const token = unissuedToken();

      expect(internals.digest(token)).toBe(sha256Hex(token));
      expect(internals.digest(token)).not.toBe(token);
    });

    it('a stored digest matches only the same digest — never an absent or emptied one', () => {
      const digest = sha256Hex('one token');

      expect(internals.matches(digest, digest)).toBe(true);
      expect(internals.matches(sha256Hex('another token'), digest)).toBe(false);
      expect(internals.matches(null, digest)).toBe(false);
      expect(internals.matches(undefined, digest)).toBe(false);
      expect(internals.matches('', digest)).toBe(false);
    });

    it('an expiry is live only as a valid timestamp in the future', () => {
      expect(internals.isLive(moment().add(1, 'minute'))).toBe(true);
      expect(internals.isLive(moment().subtract(1, 'minute'))).toBe(false);
      expect(internals.isLive(null)).toBe(false);
      expect(internals.isLive(undefined)).toBe(false);
      expect(internals.isLive(moment.invalid())).toBe(false);
    });

    it("redeem writes only while the row still carries the token's digest", async () => {
      const { user, token: live } = await armResetToken('reset-redeem@test.local');
      const before = (await userRow(user.id)).password;

      await expect(new PasswordResetToken().redeem(user, unissuedToken(), 'other-hash')).resolves.toBe(false);
      await expect(new PasswordResetToken().redeem(user, sha256Hex(live), 'other-hash')).resolves.toBe(false);
      expect((await userRow(user.id)).password).toBe(before);

      await expect(new PasswordResetToken().redeem(user, live, 'new-hash')).resolves.toBe(true);
      const row = await userRow(user.id);
      expect(row.password).toBe('new-hash');
      expect(row.passwordResetToken).toBeNull();
      expect(row.passwordResetTokenExpiration).toBeNull();
    });

    it('revoke clears the row only while it still carries the token — a newer token is left alone', async () => {
      const { user, token: withdrawn } = await armResetToken('reset-revoke@test.local');
      const newer = await new PasswordResetToken().mint(user);

      await new PasswordResetToken().revoke(user, withdrawn);
      expect((await userRow(user.id)).passwordResetToken).toBe(sha256Hex(newer));

      await new PasswordResetToken().revoke(user, newer);
      const row = await userRow(user.id);
      expect(row.passwordResetToken).toBeNull();
      expect(row.passwordResetTokenExpiration).toBeNull();
      expect(row.password).toBe('test');
    });

    it('mintedAt is the moment the outstanding token was minted — undefined when the row carries none', async () => {
      const idle = await testEnv.createUser({ name: 'Reset User', email: 'reset-minted-at-idle@test.local' });
      const { user } = await armResetToken('reset-minted-at@test.local');

      expect(new PasswordResetToken().mintedAt(idle)).toBeUndefined();
      const mintedAt = new PasswordResetToken().mintedAt(await userRow(user.id));
      expect(mintedAt).toBeDefined();
      expect(Math.abs(moment().diff(mintedAt, 'seconds'))).toBeLessThan(30);
    });
  });
});
