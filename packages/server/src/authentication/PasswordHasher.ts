import { createHash, timingSafeEqual } from 'crypto';
import * as argon2 from 'argon2';

/**
 * `human` credentials are human-chosen (low-entropy) and get the full KDF; `machine` credentials
 * are 256-bit generated secrets (MachineCredentials mint) where key stretching adds no security —
 * the secret's entropy already exceeds any brute-force budget — and a ~100ms KDF would tax the
 * bridge's log-in-fresh-per-poll pattern for nothing, so they stay sha256.
 */
export type PasswordHashMode = 'human' | 'machine';

/**
 * The one owner of credential hashing. Every path that writes or checks the user table's
 * `password` column goes through this class: authenticate (login), Signup.createAccount,
 * executePasswordReset, UpdateUserInfo.updatePassword, AccountDeletion re-auth, and
 * MachineCredentials minting.
 *
 * Exactly two self-describing at-rest formats:
 * - argon2id encoded (`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`) — human passwords.
 *   The per-user random salt and the cost parameters live inside the encoded string.
 * - sha256 hex (64 chars, never starts with `$`) — the legacy human format (pre-KDF rows,
 *   upgraded in place on next login via verify-then-rehash) AND the permanent machine format
 *   (see `PasswordHashMode`).
 */
export class PasswordHasher {
  /**
   * argon2id cost, pinned so a package upgrade can't silently change what we write: 64 MiB
   * memory, 3 passes, parallelism 4 — RFC 9106's second recommended parameter set (its
   * memory-constrained option). Measured ~23ms/hash on an M-series dev machine — the ~100ms
   * class on typical server vCPUs.
   */
  private static readonly ARGON2_OPTIONS: argon2.HashOptions = {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  };

  private static readonly ARGON2ID_PREFIX = '$argon2id$';

  async hash(password: string, mode: PasswordHashMode = 'human'): Promise<string> {
    if (mode === 'machine') {
      return this.sha256Hex(password);
    }

    return await argon2.hash(password, PasswordHasher.ARGON2_OPTIONS);
  }

  /**
   * Format-discriminating verify. `storedHash` absent means the row has no credential yet
   * (a machine row before its first mint) — no password matches it.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (!storedHash) {
      return false;
    }

    if (storedHash.startsWith(PasswordHasher.ARGON2ID_PREFIX)) {
      return await argon2.verify(storedHash, password);
    }

    return this.constantTimeEqual(storedHash, this.sha256Hex(password));
  }

  /**
   * True when a verified credential should be re-written in the current format: legacy sha256
   * under `human` mode. Machine rows never rehash — sha256 IS their current format.
   */
  needsRehash(storedHash: string, mode: PasswordHashMode = 'human'): boolean {
    if (mode === 'machine') {
      return false;
    }

    return !storedHash.startsWith(PasswordHasher.ARGON2ID_PREFIX);
  }

  /** Byte-identical to the legacy crypto-js `sha256(value).toString()` (UTF-8 in, lowercase hex out). */
  private sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private constantTimeEqual(stored: string, candidate: string): boolean {
    const storedBytes = Buffer.from(stored, 'utf8');
    const candidateBytes = Buffer.from(candidate, 'utf8');
    return storedBytes.length === candidateBytes.length && timingSafeEqual(storedBytes, candidateBytes);
  }
}
