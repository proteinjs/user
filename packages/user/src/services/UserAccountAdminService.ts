import { Service, serviceFactory } from '@proteinjs/service';

export const getUserAccountAdminService = serviceFactory<UserAccountAdminService>(
  '@proteinjs/user/UserAccountAdminService'
);

/**
 * A user manager's edits of ANOTHER account's plain cells — its name, its email address and
 * whether that address is verified. The user table has no generic write door (every `DbService`
 * insert, update and delete on it is refused, whoever asks), so this service is the one way a
 * client changes these cells on an account that is not its own; a person's own name rides
 * `UpdateUserInfoService.updateName`. Every change writes a `user_account_event` audit row (actor,
 * target, field; `created` is the timestamp) in the same transaction as the cell.
 *
 * Changing the email address un-verifies it: `emailVerified` is cleared with the outstanding
 * verification token, the account's sessions end (a session is bound to the address it signed in
 * with), and the person confirms the new address through the account page's re-send — the one
 * mailed road (`SignupService.resendEmailVerification`). The service sends no mail itself.
 *
 * The door is the `users` permission — the same trust that reads these rows.
 */
export interface UserAccountAdminService extends Service {
  /** Set an account's display name. A blank name is refused. Already that name: no change, no audit row. */
  setName(userId: string, name: string): Promise<void>;
  /**
   * Set an account's email address (lowercased). Refused when the address is not well formed, when
   * another account holds it, or when the account is a machine account (its address is declared in
   * code). Clears `emailVerified` and the verification token and ends the account's sessions.
   * Already that address: no change, no audit row.
   */
  setEmail(userId: string, email: string): Promise<void>;
  /**
   * Mark an account's address verified or not. Marking it verified clears the outstanding
   * verification token (a confirmed address needs no pending link). Already so: no change, no audit row.
   */
  setEmailVerified(userId: string, verified: boolean): Promise<void>;
}
