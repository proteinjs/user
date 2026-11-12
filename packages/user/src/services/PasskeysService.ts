import { Service, serviceFactory } from '@proteinjs/service';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { Moment } from 'moment';

export const getPasskeysService = serviceFactory<PasskeysService>('@proteinjs/user/PasskeysService');

/** A passkey as its owner's list shows it. Never its key, never its credential id. */
export type PasskeyView = {
  id: string;
  /** The name its owner sees, and may change (`rename`). */
  name: string;
  /** When it was added. */
  created: Moment;
  /** When it last signed in or confirmed an act; null until it has. */
  lastUsedAt: Moment | null;
  /** Whether it was backed up (synced across the person's devices) when last used. */
  backedUp: boolean;
};

/** The caller's passkeys, and whether the caller's account must sign in with one. */
export type PasskeyList = { required: boolean; passkeys: PasskeyView[] };

/**
 * The act a confirmation is asked for. A confirmation made for one act — and, for a removal or a
 * reset, for one passkey or one person — confirms no other.
 */
export type PasskeyConfirmationPurpose =
  | { act: 'add' }
  | { act: 'remove'; passkeyId: string }
  | { act: 'reset'; userId: string };

/**
 * A step the device's passkey sheet answers: `options` is what the sheet takes (as JSON), `token`
 * names the step's challenge and is handed back with the sheet's answer. A step is good once, in
 * the session that began it, for five minutes.
 */
export type PasskeyConfirmationStep = { token: string; options: PublicKeyCredentialRequestOptionsJSON };
export type PasskeyAddStep = { token: string; options: PublicKeyCredentialCreationOptionsJSON };

/** A confirmation: a confirmation step's token with the assertion the device's sheet answered it with. */
export type PasskeyConfirmation = { token: string; assertion: AuthenticationResponseJSON };

/**
 * A person's own passkeys — the second factor an account that holds an administrative role signs
 * in with. The account is always the session's: no method takes an account id, and none reads or
 * writes another account's passkeys. The door is any signed-in account; adding is for an account
 * that must use a passkey (`list().required`), and nothing here runs where the deployment declares
 * no relying party.
 *
 * ACTS ON THE PASSKEYS ASK AGAIN. Adding a passkey when the account already has one, and removing
 * one, each need a confirmation: a fresh assertion by one of the account's own passkeys, begun
 * with `beginConfirmation` for exactly that act and answered by the device's sheet. A confirmation
 * is good once, in the session that began it, for five minutes.
 *
 * Every add and every removal writes a `user_account_event` audit row (`field` 'passkeys', `value`
 * 'added' or 'removed'; the person is both actor and target) and mails the account's address.
 */
export interface PasskeysService extends Service {
  /** The caller's passkeys, oldest first, and whether the caller's account must use one. */
  list(): Promise<PasskeyList>;
  /** Begin a confirmation for `purpose`: the step one of the caller's passkeys answers. Refused when the caller has none. */
  beginConfirmation(purpose: PasskeyConfirmationPurpose): Promise<PasskeyConfirmationStep>;
  /**
   * Begin adding a passkey: the step the device's sheet answers by creating one. Needs a
   * confirmation made for `{ act: 'add' }` when the account already has a passkey; refused for an
   * account that need not use one.
   */
  beginAdd(confirmation?: PasskeyConfirmation): Promise<PasskeyAddStep>;
  /** Finish adding: `token` is the add step's, `registration` the device's answer. Resolves to the new passkey. */
  finishAdd(token: string, registration: RegistrationResponseJSON): Promise<PasskeyView>;
  /** Name one of the caller's passkeys. A blank name is refused. */
  rename(id: string, name: string): Promise<void>;
  /**
   * Remove one of the caller's passkeys, with a confirmation made for removing exactly that one.
   * The last passkey of an account that must use one is refused. Every OTHER session of the
   * account ends; the one that removed it stays.
   */
  remove(id: string, confirmation: PasskeyConfirmation): Promise<void>;
}
