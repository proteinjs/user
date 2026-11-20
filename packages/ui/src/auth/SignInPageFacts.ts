import { SIGN_IN_PAGE_FACTS_SCRIPT_KEY } from '@proteinjs/user';

declare let proteinjs: any;

/**
 * The sign-in pages' read of what the server wrote into the page at load (`@proteinjs/user`
 * signInPageFacts; user-server SignInPageFactsScript), so Log in and Sign up paint the right thing at
 * their first render and never after a call. A page that carries no fact reads as closed: the server
 * decides in any case, and a closed page only shows a way to ask for an invite.
 */
export class SignInPageFacts {
  /** True when the page says an account can be made without an invite. */
  static signupOpen(): boolean {
    const facts = SignInPageFacts.carried();
    return !!facts && typeof facts === 'object' && (facts as { signupOpen?: unknown }).signupOpen === true;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The facts as the page carries them, or undefined when the page carries none. */
  private static carried(): unknown {
    return typeof proteinjs === 'object' && proteinjs !== null ? proteinjs[SIGN_IN_PAGE_FACTS_SCRIPT_KEY] : undefined;
  }
}
