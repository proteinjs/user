import { Service, serviceFactory } from '@proteinjs/service';
import { PasskeyConfirmation } from './PasskeysService';

export const getPasskeyAdminService = serviceFactory<PasskeyAdminService>('@proteinjs/user/PasskeyAdminService');

/**
 * An admin's acts on ANOTHER person's passkeys — the recovery road when a person has lost every
 * passkey: the admin resets them, and the person adds a new one at their next sign-in. The door is
 * the `admin` role alone (the door of `SetUserStatusService`): a holder of `users` who could reset
 * could then take an administrative account through its address.
 */
export interface PasskeyAdminService extends Service {
  /** How many passkeys the account has. */
  count(userId: string): Promise<number>;
  /**
   * Remove every passkey of the account and end every session of it, with a confirmation the
   * caller made for resetting exactly that account (`PasskeysService.beginConfirmation` with
   * `{ act: 'reset', userId }`, answered by the caller's own passkey). Refused on the caller's own
   * account and on a declared machine account. Writes one `user_account_event` audit row (`field`
   * 'passkeys', `value` 'reset') naming the caller and the account, and mails the account's address.
   */
  reset(userId: string, confirmation: PasskeyConfirmation): Promise<void>;
}
