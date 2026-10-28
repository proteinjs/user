import { User } from '@proteinjs/user';
import { MailedToken } from './MailedToken';

/**
 * The email-verification token: a `MailedToken` on the row's `emailVerificationToken` /
 * `emailVerificationTokenExpiration` cells, live for a week, spent by the write that marks the
 * address verified. Minted for an account that signs up without an invite (the welcome mail
 * carries its link) and again by `SignupService.resendEmailVerification`; an account created
 * from an invite proved its address by receiving the invite and never carries one.
 */
export class EmailVerificationToken extends MailedToken {
  /**
   * A week: a welcome mail read late should still confirm; the account works meanwhile, and a
   * lapsed link is answered with the way to a new one.
   */
  static readonly LIFETIME_DAYS = 7;

  constructor() {
    super(
      { token: 'emailVerificationToken', expiration: 'emailVerificationTokenExpiration' },
      { amount: EmailVerificationToken.LIFETIME_DAYS, unit: 'days' }
    );
  }

  /**
   * Confirm the address: `emailVerified` set and the token cleared in one conditional update, so
   * a link confirms once. Resolves false when the token was already spent.
   */
  async confirm(user: User, token: string): Promise<boolean> {
    return await this.spend(user, token, { emailVerified: true });
  }
}
