import { Page } from '@proteinjs/ui';
import { UserAuth } from '@proteinjs/user';

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
