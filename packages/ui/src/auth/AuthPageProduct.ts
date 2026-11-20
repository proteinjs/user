import type { ComponentType } from 'react';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * THE PRODUCT'S PART IN THE SIGN-IN PAGES: the one hand-in between a product and this library's Log in
 * and Sign up pages. The library is open source and carries no product's name or words, so whatever on
 * those pages is the product's own comes through here.
 *
 * Where it lives and why: a registration in user-ui (the `RoleCatalogEntry` pattern: an interface that
 * extends Loadable, found through the reflection graph), registered by a class in the product's own ui
 * package. A ui registration because the pages read it while they render in the browser, and because
 * later members are React (a sentence with two tappable words that open the product's own sheets). A
 * class the product writes in its ui package is in that package's reflection graph and is found in the
 * browser the same way a product's `RecordFormCustomization` is found by db-ui.
 *
 * Its shape: one object, members added as the pages need them, each read by the one page that shows it.
 * Today the closed state's words, the sign-up page's agreement sentence and the sign-up's timing token.
 * Planned, not built here: the descriptions of the provider buttons. With no registration the pages show
 * only the library's own words, and a sign-up carries no timing token.
 */
export interface AuthPageProduct extends Loadable {
  /** The line under "Forgot password?" while sign-up is closed: its words and the address it opens. */
  signupClosedLine: { words: string; href: string };
  /** The sentence on the sign-up page's closed panel. */
  signupClosedSentence: string;
  /**
   * The sentence above the sign-up page's Sign up button (without an invite), rendered by the product so
   * that the words a person taps open the product's own pages. The page sets its type size and color;
   * with none registered there is no sentence and no space for one.
   */
  signupAgreementSentence?: ComponentType;
  /**
   * The timing token a sign-up without an invite carries for the product's check (user-server
   * `SignupGuardFacts.formToken`): the sign-up form makes one of these when it opens. With none
   * registered the sign-up carries no token.
   */
  signupFormToken?: () => SignupFormToken;
}

/**
 * The product's timing token for one sign-up form. The form asks for a token when it opens and again
 * after any refused submission (`renew`), and takes the token to send at submit (`forSubmit`), its Sign up
 * button busy while that waits. The numbers (how old a token may be, how long a person must have had the
 * form) are the product's.
 */
export interface SignupFormToken {
  renew(): void;
  forSubmit(): Promise<string>;
}

/** The product's registration, if one was made (the first found). */
export class AuthPageProducts {
  static registered(): AuthPageProduct | undefined {
    return SourceRepository.get().object<AuthPageProduct>('@proteinjs/user-ui/AuthPageProduct');
  }
}
