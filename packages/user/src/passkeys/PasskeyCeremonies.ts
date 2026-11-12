import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/** What a device's passkey sheet takes to create a passkey, as JSON — the form the server sends it in. */
export type PasskeyCreationOptions = PublicKeyCredentialCreationOptionsJSON;
/** What a device's passkey sheet takes to assert a passkey, as JSON. */
export type PasskeyRequestOptions = PublicKeyCredentialRequestOptionsJSON;
/** The sheet's answer to a creation, as JSON — the form the server verifies. */
export type PasskeyRegistration = RegistrationResponseJSON;
/** The sheet's answer to an assertion, as JSON. */
export type PasskeyAssertion = AuthenticationResponseJSON;

/**
 * How a ceremony ended:
 * - `done` — the device's sheet answered; `response` is what the server verifies;
 * - `cancelled` — nothing came of it: the person closed the sheet, it gave up waiting, or the
 *   device refused. Nothing was sent anywhere, and the same step can be tried again;
 * - `unavailable` — this browser, or this app's web view, cannot run a passkey ceremony here at
 *   all (no WebAuthn, or the page may not use one for this site).
 */
export type PasskeyCeremonyOutcome<Response> =
  | { status: 'done'; response: Response }
  | { status: 'cancelled' }
  | { status: 'unavailable' };

/**
 * The two passkey ceremonies a person's device runs — creating a passkey and asserting one — for
 * every page that asks for them (the login page's second step; an account page's passkeys).
 *
 * The ONE importer of `@simplewebauthn/browser`, and it imports it INSIDE its methods: this
 * package is loaded by server processes too, and a module-level import would load a browser
 * library there. A page hands a ceremony the options the server sent, as they are, and gets back
 * how it ended — never an error to read: what the browser raised is sorted here, once, into the
 * three outcomes a page can act on.
 *
 * A ceremony must start from a person's own tap: a browser raises its passkey sheet only inside
 * one, so a page calls `register` and `authenticate` from the handler of the button that asks.
 */
export class PasskeyCeremonies {
  /** The errors that mean the ceremony cannot run here at all, by the name the browser gives them. */
  private static readonly UNAVAILABLE = ['NotSupportedError', 'SecurityError'];

  /**
   * Whether this browser can run a passkey ceremony at all. It asks for WebAuthn itself and
   * nothing narrower: a platform-authenticator check has answered "no" in browsers where a passkey
   * then worked, so a page must not hide its button on one.
   */
  async supported(): Promise<boolean> {
    const { browserSupportsWebAuthn } = await import('@simplewebauthn/browser');
    return browserSupportsWebAuthn();
  }

  /** Create a passkey: raises the device's sheet for `options` and resolves to how it ended. */
  async register(options: PasskeyCreationOptions): Promise<PasskeyCeremonyOutcome<PasskeyRegistration>> {
    return await this.run(async (library) => await library.startRegistration({ optionsJSON: options }));
  }

  /** Assert a passkey: raises the device's sheet for `options` and resolves to how it ended. */
  async authenticate(options: PasskeyRequestOptions): Promise<PasskeyCeremonyOutcome<PasskeyAssertion>> {
    return await this.run(async (library) => await library.startAuthentication({ optionsJSON: options }));
  }

  /** One ceremony, with what the browser raised sorted into an outcome. */
  private async run<Response>(
    ceremony: (library: typeof import('@simplewebauthn/browser')) => Promise<Response>
  ): Promise<PasskeyCeremonyOutcome<Response>> {
    const library = await import('@simplewebauthn/browser');
    if (!library.browserSupportsWebAuthn()) {
      return { status: 'unavailable' };
    }

    try {
      return { status: 'done', response: await ceremony(library) };
    } catch (error: unknown) {
      // The library keeps the browser's own name on what it raises (a `NotAllowedError` for a
      // closed sheet, a `SecurityError` for a page that may not use a passkey for this site).
      const name = (error as { name?: unknown } | null | undefined)?.name;
      return PasskeyCeremonies.UNAVAILABLE.includes(String(name)) ? { status: 'unavailable' } : { status: 'cancelled' };
    }
  }
}
