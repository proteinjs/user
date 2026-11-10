import { createHash, randomBytes } from 'crypto';

/**
 * The value of a token mailed to someone as a link — the one owner of its shape, its mint and
 * its form at rest, shared by every kind: the password reset and the email verification on the
 * user row (`MailedToken`) and the invite on its own row (`Signup`).
 *
 * A token is 32 bytes from the platform CSPRNG, hex-encoded (64 lowercase hex characters). It
 * exists only in the link mailed to the person: a row stores its SHA-256 digest (hex), never the
 * token, so a read of the table yields nothing that can be presented — a digest is not a token,
 * and presenting one is hashed again and matches no row. A fast unsalted hash is enough because
 * the input is 256 bits of CSPRNG output, not a human-chosen secret.
 *
 * Anything that is not a value of the token's shape is refused BEFORE any lookup (`parse`): a
 * filter built from a request value that is not a token does not compare the way a token does
 * (`null` renders as `IS NULL`, an empty string matches an emptied column, other types reach the
 * driver).
 */
export class MailedTokenValue {
  private static readonly SHAPE = /^[0-9a-f]{64}$/;

  /** A fresh token: the only time its value exists outside the mailed link. */
  static mint(): string {
    return randomBytes(32).toString('hex');
  }

  /** What a row stores in place of a token: its SHA-256, hex-encoded. */
  static digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** The presented value when it has a token's shape; undefined for anything else, whatever its type. */
  static parse(presented: unknown): string | undefined {
    return typeof presented === 'string' && MailedTokenValue.SHAPE.test(presented) ? presented : undefined;
  }
}
