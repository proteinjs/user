import { PasskeyCeremonies } from '../src/passkeys/PasskeyCeremonies';

/**
 * The passkey ceremonies, against the REAL browser library with the platform beneath it faked:
 * `PublicKeyCredential` (what the library reads to know WebAuthn exists) and
 * `navigator.credentials` (what raises the device's sheet). A page never reads what the browser
 * raised — each ceremony resolves to one of three outcomes: the sheet answered, nothing came of
 * it, or passkeys cannot run here at all.
 */
type Platform = {
  PublicKeyCredential?: unknown;
  navigator?: unknown;
  location?: unknown;
};
const platform = globalThis as unknown as Platform;
const original: Platform = {
  PublicKeyCredential: platform.PublicKeyCredential,
  navigator: platform.navigator,
  location: platform.location,
};

/** The browser's own error for a ceremony that did not finish, by the name the spec gives it. */
const raised = (name: string) => Object.assign(new Error(`the browser raised ${name}`), { name });
const bytes = (text: string) => new TextEncoder().encode(text).buffer;

/** A device whose sheet does `get` for an assertion and `create` for a new passkey. */
const device = (sheet: { get?: () => Promise<unknown>; create?: () => Promise<unknown> }) => {
  platform.PublicKeyCredential = function PublicKeyCredential() {};
  platform.navigator = { credentials: sheet };
  platform.location = { hostname: 'app.example.test' };
};

const REQUEST = { challenge: 'Y2hhbGxlbmdl', rpId: 'example.test', allowCredentials: [] };
const CREATION = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { name: 'Example', id: 'example.test' },
  user: { id: 'dXNlcg', name: 'ada@example.com', displayName: 'Ada' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' as const }],
};

describe('PasskeyCeremonies', () => {
  afterEach(() => {
    Object.assign(platform, original);
  });

  it('a sheet that answers resolves done with the response as the server takes it; one the person closes, or that gives up, resolves cancelled; a browser that may not or cannot run one resolves unavailable', async () => {
    const ceremonies = new PasskeyCeremonies();

    device({
      get: async () => ({
        id: 'YS1jcmVkZW50aWFs',
        rawId: bytes('a-credential'),
        type: 'public-key',
        response: {
          authenticatorData: bytes('data'),
          clientDataJSON: bytes('client'),
          signature: bytes('signature'),
        },
        getClientExtensionResults: () => ({}),
      }),
      create: async () => ({
        id: 'YS1uZXctY3JlZGVudGlhbA',
        rawId: bytes('a-new-credential'),
        type: 'public-key',
        response: { attestationObject: bytes('attestation'), clientDataJSON: bytes('client') },
        getClientExtensionResults: () => ({}),
      }),
    });
    expect(await ceremonies.supported()).toBe(true);
    expect(await ceremonies.authenticate(REQUEST)).toMatchObject({
      status: 'done',
      response: { id: 'YS1jcmVkZW50aWFs', type: 'public-key', response: { signature: 'c2lnbmF0dXJl' } },
    });
    expect(await ceremonies.register(CREATION)).toMatchObject({
      status: 'done',
      response: { id: 'YS1uZXctY3JlZGVudGlhbA', response: { attestationObject: 'YXR0ZXN0YXRpb24' } },
    });

    const outcomes: Record<string, string[]> = {};
    for (const name of [
      'NotAllowedError',
      'AbortError',
      'InvalidStateError',
      'UnknownError',
      'SecurityError',
      'NotSupportedError',
    ]) {
      const refuses = async () => {
        throw raised(name);
      };
      device({ get: refuses, create: refuses });
      outcomes[name] = [(await ceremonies.authenticate(REQUEST)).status, (await ceremonies.register(CREATION)).status];
    }
    expect(outcomes).toEqual({
      NotAllowedError: ['cancelled', 'cancelled'],
      AbortError: ['cancelled', 'cancelled'],
      InvalidStateError: ['cancelled', 'cancelled'],
      UnknownError: ['cancelled', 'cancelled'],
      SecurityError: ['unavailable', 'unavailable'],
      NotSupportedError: ['unavailable', 'unavailable'],
    });
  });

  it('with no WebAuthn in the browser nothing is supported and no sheet is asked for: each ceremony resolves unavailable', async () => {
    const get = jest.fn();
    const create = jest.fn();
    device({ get, create });
    platform.PublicKeyCredential = undefined;
    const ceremonies = new PasskeyCeremonies();

    expect(await ceremonies.supported()).toBe(false);
    expect(await ceremonies.authenticate(REQUEST)).toEqual({ status: 'unavailable' });
    expect(await ceremonies.register(CREATION)).toEqual({ status: 'unavailable' });
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
