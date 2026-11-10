import { createHash } from 'crypto';

/**
 * The legacy credential format a pre-KDF row holds — an unsalted SHA-256 of the password, hex —
 * computed here with the platform's hash so a suite can seed one without the crypto-js dependency
 * the package no longer carries (byte-identical to crypto-js's `sha256(x).toString()`).
 */
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
