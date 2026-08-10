/**
 * Abstract permission slugs the user-management surfaces declare. Seeing users and granting
 * power are different trusts, so they are separate permissions. The consumer app maps slugs to
 * its roles via `PermissionRolesMapping` (@proteinjs/user-auth); 'admin' passes both
 * (break-glass).
 */
export const USER_PERMISSIONS = {
  /** View and manage user records and invites — everything except the roles column. */
  users: 'users',
  /** Grant and revoke roles, through the Roles service only (audited per change). */
  roles: 'roles',
  /**
   * View session records — a different trust than 'users' people-management (session rows carry
   * auth material). Read-only by design: session writes are system-written (DbSessionStore).
   */
  sessions: 'sessions',
} as const;
