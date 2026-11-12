import { createHash, createSign, generateKeyPairSync, randomBytes } from 'crypto';

/** One ceremony as the authenticator and the browser around it ran it. */
export type SoftwareCeremony = {
  /** The origin of the page the ceremony ran on, as a browser writes it into the client data. */
  origin: string;
  /** Whether the authenticator verified the person (a PIN, a fingerprint). Verified unless said otherwise. */
  userVerified?: boolean;
};

/** A CBOR map, as its entries in the order they are written. */
type CborMap = { entries: [number | string, CborValue][] };
type CborValue = number | string | Buffer | CborMap;

/**
 * A passkey authenticator in software, for the suites: one ES256 credential, and the two answers a
 * browser hands back for it — `register` is `navigator.credentials.create`'s, `assert` is
 * `navigator.credentials.get`'s — built from the options the door answered, the way a browser
 * builds them: the authenticator data (the relying-party id's hash, the flags, the signature
 * counter, and at registration the attested credential with its COSE key), the client data naming
 * the origin and the challenge, a `none` attestation object, and a DER signature over the two.
 *
 * It shares no code with the library that verifies its answers: the CBOR, the COSE key and the
 * base64url are written here, so a suite that verifies one of its answers has run the verifier's
 * whole path — the decode, the key, the signature — against bytes it did not produce itself.
 *
 * Test folder only.
 */
export class SoftwareAuthenticator {
  private static readonly USER_PRESENT = 0x01;
  private static readonly USER_VERIFIED = 0x04;
  private static readonly ATTESTED_CREDENTIAL = 0x40;
  /** The all-zero AAGUID an authenticator reports under a `none` attestation. */
  private static readonly AAGUID = Buffer.alloc(16);

  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly rawId = randomBytes(32);
  private signCount = 0;

  /** The credential's id, base64url — what the door stores and what an answer names. */
  get credentialId(): string {
    return SoftwareAuthenticator.base64url(this.rawId);
  }

  /** How many assertions the credential has signed — the signature counter its next verifier will have seen. */
  get signatureCount(): number {
    return this.signCount;
  }

  /** The answer to the door's registration options: a new credential's attestation. */
  register(options: { challenge: string; rp: { id?: string } }, ceremony: SoftwareCeremony) {
    const authenticatorData = this.authenticatorData(String(options.rp.id), ceremony, true);
    const attestationObject = SoftwareAuthenticator.cbor({
      entries: [
        ['fmt', 'none'],
        ['attStmt', { entries: [] }],
        ['authData', authenticatorData],
      ],
    });
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: this.clientData('webauthn.create', options.challenge, ceremony),
        attestationObject: SoftwareAuthenticator.base64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** The answer to the door's authentication options: an assertion signed by the credential. */
  assert(options: { challenge: string; rpId?: string }, ceremony: SoftwareCeremony) {
    this.signCount += 1;
    const authenticatorData = this.authenticatorData(String(options.rpId), ceremony, false);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, ceremony);
    const clientDataHash = createHash('sha256').update(Buffer.from(clientDataJSON, 'base64')).digest();
    const signature = createSign('SHA256')
      .update(Buffer.concat([authenticatorData, clientDataHash]))
      .sign(this.keys.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON,
        authenticatorData: SoftwareAuthenticator.base64url(authenticatorData),
        signature: SoftwareAuthenticator.base64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** The client data a browser collects, base64url: the ceremony's type, the challenge and the page's origin. */
  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, ceremony: SoftwareCeremony): string {
    return SoftwareAuthenticator.base64url(
      Buffer.from(JSON.stringify({ type, challenge, origin: ceremony.origin, crossOrigin: false }), 'utf8')
    );
  }

  /** The relying-party id's hash, the flags, the counter, and — at registration — the attested credential. */
  private authenticatorData(rpId: string, ceremony: SoftwareCeremony, attested: boolean): Buffer {
    const flags =
      SoftwareAuthenticator.USER_PRESENT |
      (ceremony.userVerified === false ? 0 : SoftwareAuthenticator.USER_VERIFIED) |
      (attested ? SoftwareAuthenticator.ATTESTED_CREDENTIAL : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount, 0);
    const head = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), counter]);
    if (!attested) {
      return head;
    }

    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.rawId.length, 0);
    return Buffer.concat([head, SoftwareAuthenticator.AAGUID, idLength, this.rawId, this.coseKey()]);
  }

  /** The public key as a COSE key: EC2 (kty 2), ES256 (alg -7), P-256 (crv 1), and the point's x and y. */
  private coseKey(): Buffer {
    // A P-256 key's SPKI ends in the uncompressed point: 0x04, then x and y, 32 bytes each.
    const spki = this.keys.publicKey.export({ type: 'spki', format: 'der' });
    const x = spki.slice(spki.length - 64, spki.length - 32);
    const y = spki.slice(spki.length - 32);
    return SoftwareAuthenticator.cbor({
      entries: [
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ],
    });
  }

  /** The few CBOR items a ceremony needs: integers, byte strings, text strings and maps. */
  private static cbor(value: CborValue): Buffer {
    if (typeof value === 'number') {
      return value >= 0 ? SoftwareAuthenticator.cborHead(0, value) : SoftwareAuthenticator.cborHead(1, -1 - value);
    }
    if (typeof value === 'string') {
      const text = Buffer.from(value, 'utf8');
      return Buffer.concat([SoftwareAuthenticator.cborHead(3, text.length), text]);
    }
    if (Buffer.isBuffer(value)) {
      return Buffer.concat([SoftwareAuthenticator.cborHead(2, value.length), value]);
    }

    return Buffer.concat([
      SoftwareAuthenticator.cborHead(5, value.entries.length),
      ...value.entries.map(([key, item]) =>
        Buffer.concat([SoftwareAuthenticator.cbor(key), SoftwareAuthenticator.cbor(item)])
      ),
    ]);
  }

  /** A CBOR item's head: its major type and its argument, in the shortest form. */
  private static cborHead(major: number, argument: number): Buffer {
    if (argument < 24) {
      return Buffer.from([(major << 5) | argument]);
    }
    if (argument < 0x100) {
      return Buffer.from([(major << 5) | 24, argument]);
    }

    const wide = Buffer.alloc(3);
    wide[0] = (major << 5) | 25;
    wide.writeUInt16BE(argument, 1);
    return wide;
  }

  private static base64url(bytes: Buffer): string {
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
