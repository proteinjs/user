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
 * Today the closed state's words. Planned additions, not built here: the sign-up page's Terms sentence;
 * a way for the sign-up page to ask the product for a timing token; the descriptions of the provider
 * buttons. With no registration the pages show only the library's own words.
 */
export interface AuthPageProduct extends Loadable {
  /** The line under "Forgot password?" while sign-up is closed: its words and the address it opens. */
  signupClosedLine: { words: string; href: string };
  /** The sentence on the sign-up page's closed panel. */
  signupClosedSentence: string;
}

/** The product's registration, if one was made (the first found). */
export class AuthPageProducts {
  static registered(): AuthPageProduct | undefined {
    return SourceRepository.get().object<AuthPageProduct>('@proteinjs/user-ui/AuthPageProduct');
  }
}
