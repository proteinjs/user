import { ServerRenderedScript } from '@proteinjs/server-api';
import { SIGN_IN_PAGE_FACTS_SCRIPT_KEY, SignInPageFactsCopy } from '@proteinjs/user';
import { getDefaultInviteConfigFactory } from '../services/Signup';

/**
 * Writes the sign-in pages' facts into every page at load (`@proteinjs/user` signInPageFacts): whether
 * sign-up is open, which is the invite rule the product registered (`DefaultInviteConfigFactory`), turned
 * around. The same rule the server applies when an account is asked for, so the page and the server
 * never disagree; the page only decides what it paints first.
 */
export class SignInPageFactsScript implements ServerRenderedScript {
  async script(): Promise<string> {
    const facts: SignInPageFactsCopy = { signupOpen: !getDefaultInviteConfigFactory().getConfig().isInviteOnly };
    return `proteinjs[${JSON.stringify(SIGN_IN_PAGE_FACTS_SCRIPT_KEY)}] = ${JSON.stringify(facts)};`;
  }
}
