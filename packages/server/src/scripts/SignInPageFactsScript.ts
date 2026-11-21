import { ServerRenderedScript } from '@proteinjs/server-api';
import { SIGN_IN_PAGE_FACTS_SCRIPT_KEY, SignInPageFactsCopy } from '@proteinjs/user';
import { EmailConfirmation } from '../services/EmailConfirmation';
import { getDefaultInviteConfigFactory } from '../services/Signup';

/**
 * Writes the sign-in pages' facts into every page at load (`@proteinjs/user` signInPageFacts): whether
 * sign-up is open, which is the invite rule the product registered (`DefaultInviteConfigFactory`), turned
 * around. The same rule the server applies when an account is asked for, so the page and the server
 * never disagree; the page only decides what it paints first.
 *
 * And, for a session whose account waits for its email address to be confirmed (`EmailConfirmation`),
 * that it waits and where the link was sent. The script runs inside the request, so the session is the
 * request's own; the account's row is read only for a session that carries an address and answered as
 * nobody, so a signed-in person's page costs no read.
 */
export class SignInPageFactsScript implements ServerRenderedScript {
  async script(): Promise<string> {
    const facts: SignInPageFactsCopy = { signupOpen: !getDefaultInviteConfigFactory().getConfig().isInviteOnly };
    const waiting = await new EmailConfirmation().waitingAccount();
    if (waiting) {
      facts.awaitingEmailConfirmation = { sentTo: waiting.email };
    }
    return `proteinjs[${JSON.stringify(SIGN_IN_PAGE_FACTS_SCRIPT_KEY)}] = ${JSON.stringify(facts)};`;
  }
}
