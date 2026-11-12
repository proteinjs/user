/**
 * The password rules a person's input is held to, shared by every door that takes a new password
 * (sign-up, the reset link, the signed-in change) and by the forms that mirror the refusal before
 * the request goes out. ONE constant: the server enforces it (user-server `PasswordRules`), the
 * client repeats its sentence (user-ui `AuthValidation`, a consumer's change-password form).
 *
 * The rule is length alone — no composition classes: NIST SP 800-63B §5.1.1.2 discourages them
 * (they lower usability without raising strength). The server adds the one check a client cannot
 * make without the list: a password among the most common ones is refused with {@link TOO_COMMON}.
 *
 * Every sentence the server's check answers is on this policy's one list, {@link REFUSALS}, which
 * {@link isRefusal} reads: the server's check is typed to answer only a {@link PasswordRefusal}, so a
 * rule whose sentence is not on the list does not compile, and never reaches a form as a failure of
 * its own.
 */
export class PasswordPolicy {
  /** The fewest characters a password may have. */
  static readonly MIN_LENGTH = 8;
  /**
   * What a new password that is blank, or no text at all, is told (the server's check, first of
   * its rules; a form refuses an empty field before it sends, in its own words).
   */
  static readonly BLANK = 'New password cannot be blank';
  /** What a too-short password is told, on the client and from the server alike. */
  static readonly TOO_SHORT = `Use at least ${PasswordPolicy.MIN_LENGTH} characters` as const;
  /** What a password on the common-passwords list is told (the server's check; a client passes it through). */
  static readonly TOO_COMMON = 'That password is too common';
  /** Every refusal this policy's rules answer, in the order the server checks them — the list's one owner. */
  static readonly REFUSALS = [PasswordPolicy.BLANK, PasswordPolicy.TOO_SHORT, PasswordPolicy.TOO_COMMON] as const;

  /** The refusal a password earns by its length alone, or undefined when it is long enough. */
  static tooShort(password: string): typeof PasswordPolicy.TOO_SHORT | undefined {
    return password.length < PasswordPolicy.MIN_LENGTH ? PasswordPolicy.TOO_SHORT : undefined;
  }

  /** Whether `message` is one of this policy's refusals — a client shows it as it is, never as its own failure. */
  static isRefusal(message: string | undefined): boolean {
    return (PasswordPolicy.REFUSALS as readonly (string | undefined)[]).includes(message);
  }
}

/** One of the sentences on {@link PasswordPolicy.REFUSALS} — what the server's check may answer. */
export type PasswordRefusal = (typeof PasswordPolicy.REFUSALS)[number];
