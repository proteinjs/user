import { Loadable, SourceRepository } from '@proteinjs/reflection';

/** A WebAuthn relying party: who a passkey is made for, and the one page origin its ceremonies run on. */
export type RelyingParty = {
  /**
   * The relying-party id a passkey is bound to: the origin's host or a registrable parent of it
   * (`example.com`), or `localhost`. Permanent for the passkeys made under it — a passkey made for
   * one id is never offered for another.
   */
  id: string;
  /** The ONE origin a ceremony may run on, as a browser writes it (`https://example.com`: scheme, host, port; no trailing slash). */
  origin: string;
  /** The site's name as a person's device shows it beside the passkey. */
  name: string;
};

/**
 * A deployment's declaration of its relying party — and, by being registered, the switch of the
 * passkey second factor: a consumer that registers one requires a passkey of every person's
 * account that holds an administrative role (`SecondFactorGate`); a consumer that registers none
 * has no second factor, and nothing of it runs.
 *
 * The values are the deployment's own, declared — never read from a request: the origin handed to
 * a verification is this one string, so a response made on any other page (a sibling host under
 * the same relying-party id included) is refused. `getRelyingParty` may refuse in words when the
 * deployment's origin has no declared id; a sign-in that needs the values then fails, and no
 * session opens.
 */
export interface PasskeyRelyingParty extends Loadable {
  getRelyingParty(): RelyingParty;
}

/** The registered declaration, or undefined when the deployment declares none. */
export const getPasskeyRelyingParty = (): PasskeyRelyingParty | undefined =>
  SourceRepository.get().object<PasskeyRelyingParty>('@proteinjs/user-server/PasskeyRelyingParty');
