import { Service, serviceFactory } from '@proteinjs/service';
import { PasskeyConfirmation } from './PasskeysService';

export const getPasskeyAdminService = serviceFactory<PasskeyAdminService>('@proteinjs/user/PasskeyAdminService');

/**
 * Another person's passkeys as an admin's page shows them, in one answer — so the page keeps no copy of either rule:
 * - `count`: how many passkeys the account holds;
 * - `required`: whether the account must use a passkey to sign in — the server's one rule (an administrative role, not
 *   a declared machine account, and a relying party declared), the same answer `PasskeysService.list().required` gives
 *   the account's owner;
 * - `mayReset`: whether the caller may reset the account's passkeys — the reset's own rule (the `admin` role, never the
 *   caller's own account, never a declared machine account; never a caller with no account row, such as the built-in
 *   default admin). It does not read the count: a reset of an account that holds none changes nothing.
 */
export type PasskeyCount = { count: number; required: boolean; mayReset: boolean };

/**
 * An admin's acts on ANOTHER person's passkeys — the recovery road when a person has lost every
 * passkey: the admin resets them, and the person adds a new one at their next sign-in. The door is
 * the `admin` role alone (the door of `SetUserStatusService`): a holder of `users` who could reset
 * could then take an administrative account through its address.
 */
export interface PasskeyAdminService extends Service {
  /** How many passkeys the account has, whether it must use one, and whether the caller may reset them (`PasskeyCount`). */
  count(userId: string): Promise<PasskeyCount>;
  /**
   * Remove every passkey of the account and end every session of it, with a confirmation the
   * caller made for resetting exactly that account (`PasskeysService.beginConfirmation` with
   * `{ act: 'reset', userId }`, answered by the caller's own passkey). Refused on the caller's own
   * account and on a declared machine account. Writes one `user_account_event` audit row (`field`
   * 'passkeys', `value` 'reset') naming the caller and the account, and mails the account's address.
   */
  reset(userId: string, confirmation: PasskeyConfirmation): Promise<void>;
}
