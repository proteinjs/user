import { Page } from '@proteinjs/ui';
import { uiRoutes, UserAuth } from '@proteinjs/user';
import { SignInPageFacts } from './auth/SignInPageFacts';

/**
 * The page-auth decision `AuthenticatedPageContainer` enforces — one owner, mirrored on
 * `ServiceAuth` (services) and `TableAuth` (tables):
 * - `public`: anyone
 * - `allUsers`: any logged-in user
 * - `permission`: holders of an abstract permission slug, resolved through the consumer app's
 *   `PermissionRolesMapping` (admin passes every permission — break-glass); takes precedence
 *   over `roles` when both are set
 * - `roles`: holders of all listed roles
 * - unspecified: admin only (default deny)
 */
export function canViewPage(page: Page): boolean {
  if (page.auth?.public) {
    return true;
  }

  if (page.auth?.allUsers) {
    return UserAuth.isLoggedIn();
  }

  if (page.auth?.permission) {
    return UserAuth.hasPermission(page.auth.permission);
  }

  if (!page.auth?.roles) {
    return UserAuth.hasRole('admin');
  }

  return UserAuth.hasRoles(page.auth.roles);
}

/**
 * Where a session whose account waits for its email address to be confirmed is sent from `page`: the
 * confirmation's own address, or undefined when the page stays — every other session, and the
 * confirmation's page itself. While a session waits it has that one screen, whatever address of the
 * product it opens, pages open to everyone included (Log out there makes the person a visitor again).
 * `AuthenticatedPageContainer` reads this in one line; no page checks for itself.
 */
export function waitingSessionDestination(page: Page): string | undefined {
  const paths = Array.isArray(page.path) ? page.path : [page.path];
  if (!SignInPageFacts.awaitingEmailConfirmation() || paths.indexOf(uiRoutes.account.verifyEmail) >= 0) {
    return undefined;
  }

  return `/${uiRoutes.account.verifyEmail}`;
}
