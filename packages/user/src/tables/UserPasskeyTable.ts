import { ArrayColumn, BooleanColumn, DateTimeColumn, IntegerColumn, StringColumn, Table } from '@proteinjs/db';
import { Moment } from 'moment';
import { ScopedRecord, withScopedRecordColumns } from '../ScopedRecord';

/** Whether a passkey lives on one device or syncs across a person's devices (WebAuthn's backup eligibility). */
export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

/**
 * A passkey: a WebAuthn credential an account registered as its second factor. One row per
 * credential; `scope` is the account's id, so the rows purge with the account (a scoped table with
 * no retain policy) and every read by the account is filtered to its own rows.
 *
 * The credential id is unique ALONE, not within a scope: one authenticator credential belongs to
 * one account, and a sign-in reads the row by the account AND the credential id together.
 *
 * No door on either api, the admin included (`query: []` admits nobody, and the other operations of
 * a declared block stay closed): the rows hold the public keys a sign-in is verified against, so
 * every read and write is the server's own, made as system. An insert made as system sets `scope`
 * itself — the scope column forces its default only for a caller that is not the system.
 */
export type UserPasskey = ScopedRecord & {
  /** The credential id, base64url. */
  credentialId: string;
  /** The credential's public key (a COSE key), base64url. Never leaves the server. */
  publicKey: string;
  /** The authenticator's signature counter as last verified. */
  counter: number;
  /** How the browser can reach the authenticator ('internal', 'hybrid', 'usb', 'nfc', 'ble', …), as the registration reported them. */
  transports: string[];
  /** The authenticator model's AAGUID. */
  aaguid: string;
  deviceType: PasskeyDeviceType;
  /** Whether the passkey was backed up (synced) when last used. */
  backedUp: boolean;
  /** The name the account sees in its list of passkeys. */
  name: string;
  lastUsedAt?: Moment | null;
};

export class UserPasskeyTable extends Table<UserPasskey> {
  name = 'user_passkey';
  auth: Table<UserPasskey>['auth'] = {
    db: {
      query: [],
    },
    service: {
      query: [],
    },
  };
  indexes = [
    { name: 'user_passkey_credential_id_unique', columns: ['credentialId'] as (keyof UserPasskey)[], unique: true },
  ];
  columns: Table<UserPasskey>['columns'] = withScopedRecordColumns<UserPasskey>({
    // A credential id is at most 1023 bytes (W3C WebAuthn Level 3, Terminology), 1364 characters in base64url.
    credentialId: new StringColumn('credential_id', {}, 1364),
    publicKey: new StringColumn('public_key', {}, 'MAX'),
    // An unsigned 32-bit count: wider than a 32-bit signed integer, so the large integer.
    counter: new IntegerColumn('counter', {}, true),
    transports: new ArrayColumn<string>('transports'),
    aaguid: new StringColumn('aaguid', {}, 36),
    deviceType: new StringColumn<PasskeyDeviceType>('device_type', {}, 16),
    backedUp: new BooleanColumn('backed_up'),
    name: new StringColumn('name'),
    lastUsedAt: new DateTimeColumn('last_used_at'),
  });
}
