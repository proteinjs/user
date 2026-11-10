import { dictionary } from '@zxcvbn-ts/language-common';

/**
 * The most common passwords, bundled with the server — no network call. The list is the ranked
 * password dictionary zxcvbn ships (`@zxcvbn-ts/language-common`'s `passwords-common`, the
 * Dropbox zxcvbn data, most common first), cut to its first {@link COUNT} entries: the 10,000
 * most common. Compared case-insensitively — a capital letter on a common password is the first
 * variant a guessing script tries.
 *
 * The set is built on first use and kept for the process; the dictionary is loaded by its import.
 */
export class CommonPasswords {
  /** How many of the ranked list count as "common" — the 10,000 most common passwords. */
  static readonly COUNT = 10_000;
  private static set: Set<string> | undefined;

  /** Whether `password` is among the most common passwords. */
  static has(password: string): boolean {
    return CommonPasswords.list().has(password.trim().toLowerCase());
  }

  private static list(): Set<string> {
    if (!CommonPasswords.set) {
      // An item cap on the ranked list (the first COUNT entries), never a cut of a person's words.
      CommonPasswords.set = new Set(
        dictionary['passwords-common'].slice(0, CommonPasswords.COUNT).map((entry) => String(entry).toLowerCase())
      );
    }
    return CommonPasswords.set;
  }
}
