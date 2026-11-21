import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { User } from '@proteinjs/user';

/** What a product answers about confirming an account's email address. */
export interface EmailConfirmationConfig {
  /**
   * True where confirming the email is a mandatory step: an account whose address is not confirmed is
   * held back (`EmailConfirmation.holdsBack`) until the link mailed to it is opened.
   */
  isRequired: boolean;
}

/**
 * The product's registration of its email-confirmation rule, found through the reflection graph the way
 * the invite rule is (`DefaultInviteConfigFactory`). With none registered the rule is not asked, and the
 * library behaves exactly as it does without this class.
 */
export interface DefaultEmailConfirmationConfigFactory extends Loadable {
  getConfig(): EmailConfirmationConfig;
}

/**
 * THE MANDATORY EMAIL CONFIRMATION, in one place: whether the product asks for it, and whether an account
 * is held back by it.
 *
 * Where the product asks, an account whose address is not confirmed is held back: to the server its
 * session is nobody. That is applied in ONE place, the function that answers who a request is
 * (authorization/userCache), so everything that asks who the caller is through `UserAuth` or `UserRepo`
 * (every service, every table, every page) is closed to it without a line of its own.
 */
export class EmailConfirmation {
  /** Whether the product asks for the confirmation. */
  isRequired(): boolean {
    return this.registered()?.getConfig().isRequired === true;
  }

  /**
   * Whether `account` is held back: the product asks, and the account's address is not confirmed.
   * Anything but `true` is not confirmed (a row written before the column held a value reads null).
   */
  holdsBack(account: Pick<User, 'emailVerified'>): boolean {
    return account.emailVerified !== true && this.isRequired();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The product's registration, if one was made. */
  private registered(): DefaultEmailConfirmationConfigFactory | undefined {
    return SourceRepository.get().object<DefaultEmailConfirmationConfigFactory>(
      '@proteinjs/user-server/DefaultEmailConfirmationConfigFactory'
    );
  }
}
