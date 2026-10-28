import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import moment, { Moment } from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables, User } from '@proteinjs/user';

export type MailedTokenResolution =
  | { status: 'malformed' }
  | { status: 'unknown' }
  | { status: 'expired'; user: User }
  | { status: 'live'; user: User; token: string };

/** The two cells a token kind keeps on the user row: the stored digest and when it lapses. */
export type MailedTokenCells = {
  token: 'passwordResetToken' | 'emailVerificationToken';
  expiration: 'passwordResetTokenExpiration' | 'emailVerificationTokenExpiration';
};

/** How long a token stays live after its mint. */
export type MailedTokenLifetime = { amount: number; unit: 'minutes' | 'days' };

/**
 * A single-use token mailed to an account as a link — the one owner of the mechanism every kind
 * shares: its shape, its mint, the lookup that maps a presented value back to the user it was
 * issued to, its withdrawal, and the conditional write that spends it once. A kind (the password
 * reset, the email verification) names its two cells on the user row, its lifetime, and what
 * spending it writes.
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
 * does: `null` renders as `IS NULL` and would match every account with no pending token, an
 * empty string matches an emptied column, and other types reach the driver. The presented token
 * is then hashed, the row is looked up by that digest, and the row the lookup returns is
 * re-checked in code — its stored digest must be a string equal to the presented token's digest
 * (compared in constant time) and its expiry a real timestamp still in the future — so the
 * outcome never rests on how the storage compares.
 */
export abstract class MailedToken {
  private static readonly SHAPE = /^[0-9a-f]{64}$/;

  protected constructor(
    private readonly cells: MailedTokenCells,
    private readonly lifetime: MailedTokenLifetime
  ) {}

  /**
   * Issue a token to `user`: store its digest and its expiry on the row, replacing any token
   * outstanding, and return the token — the only time it exists outside the mailed link.
   */
  async mint(user: User): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await getDbAsSystem().update(tables.User, {
      id: user.id,
      ...this.cellsWrite(this.digest(token), moment().add(this.lifetime.amount, this.lifetime.unit)),
    });
    return token;
  }

  async resolve(presented: unknown): Promise<MailedTokenResolution> {
    const token = this.parse(presented);
    if (token === undefined) {
      return { status: 'malformed' };
    }

    const digest = this.digest(token);
    const user = await getDbAsSystem().get(tables.User, this.cellsLookup(digest));
    if (!user || !this.matches(user[this.cells.token], digest)) {
      return { status: 'unknown' };
    }

    if (!this.isLive(user[this.cells.expiration])) {
      return { status: 'expired', user };
    }

    return { status: 'live', user, token };
  }

  /**
   * Withdraw a token that never reached its owner (the mail carrying it failed to send): the row
   * is cleared only while it still carries this token's digest, so a newer token is left alone.
   */
  async revoke(user: User, token: string): Promise<void> {
    await getDbAsSystem().update(tables.User, this.cellsWrite(null, null), {
      id: user.id,
      ...this.cellsLookup(this.digest(token)),
    });
  }

  /** When the token outstanding on `user` was minted, or undefined when the row carries none. */
  mintedAt(user: User): Moment | undefined {
    const expiration = user[this.cells.expiration];
    if (!user[this.cells.token] || !expiration) {
      return undefined;
    }

    return moment(expiration).subtract(this.lifetime.amount, this.lifetime.unit);
  }

  /**
   * A log-safe reference to a presented token: a short prefix of a well-formed one's digest,
   * never the value itself and never a part of it. The routes log it only for a token that
   * resolved `unknown` — one no row carries — so it never lines up with a digest a row holds.
   * What it is for is telling refusals apart in the log: one stale link presented again reads
   * the same each time, a run of different values reads differently. 48 bits of the SHA-256 of
   * 256 random bits identify nothing and can be presented nowhere.
   */
  fingerprint(presented: unknown): string | undefined {
    const token = this.parse(presented);
    if (token === undefined) {
      return undefined;
    }

    return this.digest(token).slice(0, 12);
  }

  /**
   * Spend the token: `effect` is written and the token cleared in one conditional update — the
   * row must still carry this token's digest at write time, so two presentations of the same
   * token cannot both succeed. Resolves false when the token was already spent.
   */
  protected async spend(user: User, token: string, effect: Partial<User>): Promise<boolean> {
    const updated = await getDbAsSystem().update(
      tables.User,
      { ...effect, ...this.cellsWrite(null, null) },
      { id: user.id, ...this.cellsLookup(this.digest(token)) }
    );
    return updated === 1;
  }

  private parse(presented: unknown): string | undefined {
    return typeof presented === 'string' && MailedToken.SHAPE.test(presented) ? presented : undefined;
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

  /** The kind's two cells as a write: a digest and its expiry, or nulls to clear them. */
  private cellsWrite(digest: string | null, expiration: Moment | null): Partial<User> {
    return { [this.cells.token]: digest, [this.cells.expiration]: expiration };
  }

  /** The filter that finds the row carrying `digest` in the kind's token cell. */
  private cellsLookup(digest: string): Partial<User> {
    return { [this.cells.token]: digest };
  }
}
