import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import moment, { Moment } from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables, User } from '@proteinjs/user';

export type PasswordResetResolution =
  | { status: 'malformed' }
  | { status: 'unknown' }
  | { status: 'expired'; user: User }
  | { status: 'live'; user: User; token: string };

/**
 * The password-reset token's one owner: its shape, its mint, the lookup that maps a presented
 * value back to the user it was issued to, and its single-use redemption.
 *
 * A token is 32 bytes from the platform CSPRNG, hex-encoded (64 lowercase hex characters),
 * stored on the user row beside its expiry until it is redeemed or expires.
 *
 * Resolution refuses anything that is not a value of that shape BEFORE any lookup. A query
 * filter built from a request value that is not a token does not compare the way a token does:
 * `null` renders as `IS NULL` and would match every account with no pending reset, an empty
 * string matches an emptied column, and other types reach the driver. The row the lookup
 * returns is then re-checked in code — its stored token must be a string equal to the presented
 * one (compared in constant time) and its expiry a real timestamp still in the future — so the
 * outcome never rests on how the storage compares.
 */
export class PasswordResetToken {
  private static readonly SHAPE = /^[0-9a-f]{64}$/;

  mint(): string {
    return randomBytes(32).toString('hex');
  }

  async resolve(presented: unknown): Promise<PasswordResetResolution> {
    const token = this.parse(presented);
    if (token === undefined) {
      return { status: 'malformed' };
    }

    const user = await getDbAsSystem().get(tables.User, { passwordResetToken: token });
    if (!user || !this.matches(user.passwordResetToken, token)) {
      return { status: 'unknown' };
    }

    if (!this.isLive(user.passwordResetTokenExpiration)) {
      return { status: 'expired', user };
    }

    return { status: 'live', user, token };
  }

  /**
   * Write the new credential and clear the token in one conditional update: the row must still
   * carry this token at write time, so two presentations of the same token cannot both succeed.
   * Resolves false when the token was already redeemed.
   */
  async redeem(user: User, token: string, hashedPassword: string): Promise<boolean> {
    const updated = await getDbAsSystem().update(
      tables.User,
      { password: hashedPassword, passwordResetToken: null, passwordResetTokenExpiration: null },
      { id: user.id, passwordResetToken: token }
    );
    return updated === 1;
  }

  /** A log-safe reference to a presented token: a short digest of a well-formed one, never the value itself. */
  fingerprint(presented: unknown): string | undefined {
    const token = this.parse(presented);
    if (token === undefined) {
      return undefined;
    }

    return createHash('sha256').update(token).digest('hex').slice(0, 12);
  }

  private parse(presented: unknown): string | undefined {
    return typeof presented === 'string' && PasswordResetToken.SHAPE.test(presented) ? presented : undefined;
  }

  private matches(stored: string | null | undefined, presented: string): boolean {
    if (typeof stored !== 'string' || stored.length !== presented.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
  }

  private isLive(expiration: Moment | null | undefined): boolean {
    if (!expiration) {
      return false;
    }

    const expiresAt = moment(expiration);
    return expiresAt.isValid() && moment().isBefore(expiresAt);
  }
}
