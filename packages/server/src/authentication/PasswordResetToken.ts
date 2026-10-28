import { User } from '@proteinjs/user';
import { MailedToken, MailedTokenResolution } from './MailedToken';

export type PasswordResetResolution = MailedTokenResolution;

/**
 * The password-reset token: a `MailedToken` on the row's `passwordResetToken` /
 * `passwordResetTokenExpiration` cells, live for an hour, spent by the password write.
 *
 * No migration accompanied the move from a stored token to a stored digest: a row that still
 * holds a token minted before it never equals the digest of anything presented, so that token
 * fails validation for what remains of its hour and the person asks for a new link.
 */
export class PasswordResetToken extends MailedToken {
  private static readonly LIFETIME_MINUTES = 60;

  constructor() {
    super(
      { token: 'passwordResetToken', expiration: 'passwordResetTokenExpiration' },
      { amount: PasswordResetToken.LIFETIME_MINUTES, unit: 'minutes' }
    );
  }

  /**
   * Write the new credential and clear the token in one conditional update: the row must still
   * carry this token's digest at write time, so two presentations of the same token cannot both
   * succeed. Resolves false when the token was already redeemed.
   */
  async redeem(user: User, token: string, hashedPassword: string): Promise<boolean> {
    return await this.spend(user, token, { password: hashedPassword });
  }
}
