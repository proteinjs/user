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
 * A token is 32 bytes from the platform CSPRNG, hex-encoded (64 lowercase hex characters). The
 * token itself exists only in the link mailed to the account: the user row stores its SHA-256
 * digest (hex) beside the expiry, never the token, so a read of the table yields nothing that
 * can be presented. A digest is not a token — presenting one is hashed again and matches no row.
 * A fast unsalted hash is enough here because the input is 256 bits of CSPRNG output, not a
 * human-chosen secret.
 *
 * Resolution refuses anything that is not a value of the token's shape BEFORE any lookup. A
 * query filter built from a request value that is not a token does not compare the way a token
 * does: `null` renders as `IS NULL` and would match every account with no pending reset, an
 * empty string matches an emptied column, and other types reach the driver. The presented token
 * is then hashed, the row is looked up by that digest, and the row the lookup returns is
 * re-checked in code — its stored digest must be a string equal to the presented token's digest
 * (compared in constant time) and its expiry a real timestamp still in the future — so the
 * outcome never rests on how the storage compares.
 *
 * No migration accompanies the move from a stored token to a stored digest: a row that still
 * holds a token minted before it never equals the digest of anything presented, so that token
 * fails validation for what remains of its hour and the person asks for a new link.
 */
export class PasswordResetToken {
  private static readonly SHAPE = /^[0-9a-f]{64}$/;
  private static readonly LIFETIME_MINUTES = 60;

  /**
   * Issue a token to `user`: store its digest and its expiry on the row, replacing any token
   * outstanding, and return the token — the only time it exists outside the mailed link.
   */
  async mint(user: User): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await getDbAsSystem().update(tables.User, {
      id: user.id,
      passwordResetToken: this.digest(token),
      passwordResetTokenExpiration: moment().add(PasswordResetToken.LIFETIME_MINUTES, 'minutes'),
    });
    return token;
  }

  async resolve(presented: unknown): Promise<PasswordResetResolution> {
    const token = this.parse(presented);
    if (token === undefined) {
      return { status: 'malformed' };
    }

    const digest = this.digest(token);
    const user = await getDbAsSystem().get(tables.User, { passwordResetToken: digest });
    if (!user || !this.matches(user.passwordResetToken, digest)) {
      return { status: 'unknown' };
    }

    if (!this.isLive(user.passwordResetTokenExpiration)) {
      return { status: 'expired', user };
    }

    return { status: 'live', user, token };
  }

  /**
   * Write the new credential and clear the token in one conditional update: the row must still
   * carry this token's digest at write time, so two presentations of the same token cannot both
   * succeed. Resolves false when the token was already redeemed.
   */
  async redeem(user: User, token: string, hashedPassword: string): Promise<boolean> {
    const updated = await getDbAsSystem().update(
      tables.User,
      { password: hashedPassword, passwordResetToken: null, passwordResetTokenExpiration: null },
      { id: user.id, passwordResetToken: this.digest(token) }
    );
    return updated === 1;
  }

  /**
   * Withdraw a token that never reached its owner (the mail carrying it failed to send): the row
   * is cleared only while it still carries this token's digest, so a newer token is left alone.
   */
  async revoke(user: User, token: string): Promise<void> {
    await getDbAsSystem().update(
      tables.User,
      { passwordResetToken: null, passwordResetTokenExpiration: null },
      { id: user.id, passwordResetToken: this.digest(token) }
    );
  }

  /** When the token outstanding on `user` was minted, or undefined when the row carries none. */
  mintedAt(user: User): Moment | undefined {
    if (!user.passwordResetToken || !user.passwordResetTokenExpiration) {
      return undefined;
    }

    return moment(user.passwordResetTokenExpiration).subtract(PasswordResetToken.LIFETIME_MINUTES, 'minutes');
  }

  /** A log-safe reference to a presented token: a short prefix of a well-formed one's digest, never the value itself. */
  fingerprint(presented: unknown): string | undefined {
    const token = this.parse(presented);
    if (token === undefined) {
      return undefined;
    }

    return this.digest(token).slice(0, 12);
  }

  private parse(presented: unknown): string | undefined {
    return typeof presented === 'string' && PasswordResetToken.SHAPE.test(presented) ? presented : undefined;
  }

  /** What the row stores in place of a token: its SHA-256, hex-encoded. */
  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private matches(storedDigest: string | null | undefined, presentedDigest: string): boolean {
    if (typeof storedDigest !== 'string' || storedDigest.length !== presentedDigest.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(storedDigest), Buffer.from(presentedDigest));
  }

  private isLive(expiration: Moment | null | undefined): boolean {
    if (!expiration) {
      return false;
    }

    const expiresAt = moment(expiration);
    return expiresAt.isValid() && moment().isBefore(expiresAt);
  }
}
