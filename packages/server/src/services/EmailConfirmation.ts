import { getDbAsSystem } from '@proteinjs/db';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Session } from '@proteinjs/server-api';
import { tables, User, UserAuth } from '@proteinjs/user';

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
 *
 * What such a session can still reach of its own account goes through `waitingAccount`, and through
 * nothing else: the page's fact (scripts/SignInPageFactsScript), the re-send and the question on coming
 * back (services/Signup). The link's route (routes/verifyEmail) reads the session's address the same way.
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

  /**
   * The address the request's session carries, in lower case as every session is bound
   * (authentication/establishSession), or undefined for a request with no session: a visitor.
   */
  sessionAddress(): string | undefined {
    const address = Session.getData()?.user;
    return address ? address.toLowerCase() : undefined;
  }

  /**
   * THE SESSION'S WAITING ACCOUNT, READ DIRECTLY: the row of the session's address when that account is
   * held back and not deactivated, and nothing otherwise. Its session answers as nobody everywhere else,
   * so this is the one way its own row is reached; its readers are the three named above and no more.
   * Where no product asks for the confirmation nothing is read, the session included; a request that
   * answered as a signed-in account has no waiting account and costs no read.
   */
  async waitingAccount(): Promise<User | undefined> {
    if (!this.isRequired()) {
      return undefined;
    }

    const address = this.sessionAddress();
    if (!address || UserAuth.isLoggedIn()) {
      return undefined;
    }

    const account = await getDbAsSystem().get(tables.User, { email: address });
    return account && account.status !== 'deactivated' && this.holdsBack(account) ? account : undefined;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The product's registration, if one was made. */
  private registered(): DefaultEmailConfirmationConfigFactory | undefined {
    return SourceRepository.get().object<DefaultEmailConfirmationConfigFactory>(
      '@proteinjs/user-server/DefaultEmailConfirmationConfigFactory'
    );
  }
}
