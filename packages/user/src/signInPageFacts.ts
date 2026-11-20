/**
 * What the server writes into every page at load for the sign-in pages (Log in, Sign up) to read at
 * their first paint: `proteinjs[SIGN_IN_PAGE_FACTS_SCRIPT_KEY] = { signupOpen }` (user-server
 * SignInPageFactsScript writes it; user-ui SignInPageFacts reads it). So the log-in page's line and the
 * sign-up page's closed panel render at once, never after a call. The server decides in any case: a page
 * that says open does not let anyone past the invite rule (user-server Signup.initializeSignup).
 *
 * One fact today; a later piece adds which sign-in providers are on.
 */
export const SIGN_IN_PAGE_FACTS_SCRIPT_KEY = 'signInPageFacts';

export type SignInPageFactsCopy = {
  /** True when an account can be made without an invite: the product's invite rule, turned around. */
  signupOpen: boolean;
};

/**
 * The library's own sentence for a sign-up without an invite where one is required: the server's
 * refusal and the closed sign-up panel's words when no product registered its own. One home, read by both.
 */
export const SIGNUP_CLOSED_SENTENCE = 'An invite is required to sign up.';
