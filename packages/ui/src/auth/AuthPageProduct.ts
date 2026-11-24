import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * THE PRODUCT'S PART IN THE SIGN-IN PAGES: the one hand-in between a product and this library's sign-in pages.
 * The library is open source and carries no product's name or words, so whatever on those pages is the
 * product's own comes through here.
 *
 * Where it lives and why: a registration in user-ui (the `RoleCatalogEntry` pattern: an interface that
 * extends Loadable, found through the reflection graph), registered by a class in the product's own ui
 * package. A ui registration because the pages read it while they render in the browser.
 *
 * Its shape: one object, members added as the pages need them, each read by the one page that shows it.
 * Today the log-in page's line. With no registration the pages show only the library's own words.
 */
export interface AuthPageProduct extends Loadable {
  /**
   * The line under "Forgot password?" on the log-in page of a product whose sign-up is closed (an account is
   * made only from an invite): its words and the address it opens. The page shows it whenever one is
   * registered; a product anyone can sign up to registers none.
   */
  signupClosedLine: { words: string; href: string };
}

export class AuthPageProducts {
  /**
   * The product's registration, if one was made (the first found). None where the graph holds no such type:
   * a page mounted straight from its source file, with no package index loaded (a bare suite).
   */
  static registered(): AuthPageProduct | undefined {
    try {
      return SourceRepository.get().object<AuthPageProduct>('@proteinjs/user-ui/AuthPageProduct');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unable to find type')) {
        return undefined;
      }
      throw error;
    }
  }
}
