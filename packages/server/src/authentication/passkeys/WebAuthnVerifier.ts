import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { User, UserPasskey } from '@proteinjs/user';
import { SecondFactorGate } from '../SecondFactorGate';
import { RelyingParty } from './PasskeyRelyingParty';

/** The options a browser's `navigator.credentials.create` takes, as JSON. */
export type PasskeyRegistrationOptions = PublicKeyCredentialCreationOptionsJSON;
/** The options a browser's `navigator.credentials.get` takes, as JSON. */
export type PasskeyAuthenticationOptions = PublicKeyCredentialRequestOptionsJSON;

/** A verified registration's credential, in the passkey row's own cells. */
export type RegisteredCredential = Pick<
  UserPasskey,
  'credentialId' | 'publicKey' | 'counter' | 'transports' | 'aaguid' | 'deviceType' | 'backedUp'
>;
/** What a verified assertion says of the passkey's use, in the passkey row's own cells. */
export type CredentialUse = Pick<UserPasskey, 'counter' | 'deviceType' | 'backedUp'>;

export type RegistrationVerdict =
  | { verified: true; credential: RegisteredCredential }
  | { verified: false; reason: string };
export type AuthenticationVerdict = { verified: true; use: CredentialUse } | { verified: false; reason: string };

/**
 * The ONE importer of `@simplewebauthn/server`: the options of the two ceremonies and the two
 * verifications, for one declared relying party. Everything a verification is checked against is
 * the server's own — the challenge it minted, the relying party the deployment declared — and
 * nothing is read from the request but the response under test:
 * - the expected origin is the declared origin, ONE string (never a list, never a request header),
 *   so a response made on any other page is refused, a sibling host under the same relying-party
 *   id included;
 * - user verification is required, written out on both verifications: a response whose
 *   authenticator did not verify the person (a PIN, a fingerprint, a face) is refused;
 * - an assertion is verified against the public key of the passkey row it is handed, and only
 *   when the response names that row's credential.
 *
 * A verification never throws: whatever the library refuses, and whatever it cannot read, is a
 * verdict of not verified with a reason from a closed list — a response is the client's text, so
 * none of it reaches a log line. Base64url goes through the library's own helpers (the stored
 * public key is the COSE key as base64url; the user handle is the account id's bytes).
 */
export class WebAuthnVerifier {
  /** A credential id is at most 1023 bytes: 1364 characters of base64url, the passkey row's width. */
  private static readonly CREDENTIAL_ID_MAX_LENGTH = 1364;

  /** The library's refusals by what they are about; anything else is the last entry's words. */
  private static readonly REFUSALS: [RegExp, string][] = [
    [/response origin/i, 'the response was made on another origin'],
    [/response challenge/i, 'the response answers another challenge'],
    [/RP ID/i, 'the response was made for another relying party'],
    [/user verification|not present/i, 'the person was not verified'],
    [/counter value/i, 'the signature counter went backwards'],
  ];
  private static readonly UNREADABLE = 'the response could not be verified';

  constructor(private readonly relyingParty: RelyingParty) {}

  /**
   * The verifier for the relying party this deployment declares — made here and nowhere else, for
   * every ceremony of the package. The declaration's values are the gate's to hand out
   * (`SecondFactorGate.relyingParty`), which refuses where none is declared: no account must use a
   * passkey there, so no ceremony is ever begun.
   */
  static forDeclaredRelyingParty(): WebAuthnVerifier {
    return new WebAuthnVerifier(new SecondFactorGate().relyingParty());
  }

  /** The options for registering a passkey to `account`; the account's own passkeys are excluded, so one authenticator is not enrolled twice. */
  async registrationOptions(
    account: Pick<User, 'id' | 'email' | 'name'>,
    passkeys: UserPasskey[]
  ): Promise<PasskeyRegistrationOptions> {
    return await generateRegistrationOptions({
      rpName: this.relyingParty.name,
      rpID: this.relyingParty.id,
      userName: account.email,
      userDisplayName: account.name,
      userID: isoUint8Array.fromUTF8String(account.id),
      attestationType: 'none',
      excludeCredentials: this.descriptors(passkeys),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
  }

  /** The options for an assertion by one of `passkeys` — the account's own, and no others. */
  async authenticationOptions(passkeys: UserPasskey[]): Promise<PasskeyAuthenticationOptions> {
    return await generateAuthenticationOptions({
      rpID: this.relyingParty.id,
      allowCredentials: this.descriptors(passkeys),
      userVerification: 'required',
    });
  }

  /** Verify a registration made for `challenge`; verified, it yields the credential as the passkey row keeps it. */
  async verifyRegistration(response: unknown, challenge: string): Promise<RegistrationVerdict> {
    try {
      const verification = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.relyingParty.origin,
        expectedRPID: this.relyingParty.id,
        requireUserVerification: true,
      });
      if (!verification.verified) {
        return { verified: false, reason: WebAuthnVerifier.UNREADABLE };
      }

      const info = verification.registrationInfo;
      if (info.credential.id.length > WebAuthnVerifier.CREDENTIAL_ID_MAX_LENGTH) {
        return { verified: false, reason: WebAuthnVerifier.UNREADABLE };
      }

      return {
        verified: true,
        credential: {
          credentialId: info.credential.id,
          publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
          counter: info.credential.counter,
          transports: info.credential.transports ?? [],
          aaguid: info.aaguid,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        },
      };
    } catch (error) {
      return { verified: false, reason: WebAuthnVerifier.refusal(error) };
    }
  }

  /** Verify an assertion made for `challenge` against `passkey` — the row the caller read for the account under sign-in. */
  async verifyAuthentication(
    response: unknown,
    challenge: string,
    passkey: UserPasskey
  ): Promise<AuthenticationVerdict> {
    if (WebAuthnVerifier.credentialIdOf(response) !== passkey.credentialId) {
      return { verified: false, reason: 'the response names another credential' };
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.relyingParty.origin,
        expectedRPID: this.relyingParty.id,
        credential: {
          id: passkey.credentialId,
          publicKey: isoBase64URL.toBuffer(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports ?? undefined,
        },
        requireUserVerification: true,
      });
      if (!verification.verified) {
        return { verified: false, reason: 'the signature did not verify' };
      }

      const info = verification.authenticationInfo;
      return {
        verified: true,
        use: { counter: info.newCounter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp },
      };
    } catch (error) {
      return { verified: false, reason: WebAuthnVerifier.refusal(error) };
    }
  }

  /**
   * The credential id a response names, when it names one in a credential id's shape — read
   * before any lookup by it: a request value that is not a credential id never becomes a filter.
   */
  static credentialIdOf(response: unknown): string | undefined {
    const id = (response as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' &&
      id.length > 0 &&
      id.length <= WebAuthnVerifier.CREDENTIAL_ID_MAX_LENGTH &&
      isoBase64URL.isBase64URL(id)
      ? id
      : undefined;
  }

  /** The passkeys as the credential descriptors an options call takes. */
  private descriptors(passkeys: UserPasskey[]): { id: string; transports?: string[] }[] {
    return passkeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports ?? undefined }));
  }

  /** What a refusal was about, from the closed list — never the library's own words, which quote the response. */
  private static refusal(error: unknown): string {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    const words = typeof message === 'string' ? message : '';
    const known = WebAuthnVerifier.REFUSALS.find(([pattern]) => pattern.test(words));
    return known ? known[1] : WebAuthnVerifier.UNREADABLE;
  }
}
