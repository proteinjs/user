/**
 * The password rules a person's input is held to, shared by every door that takes a new password
 * (sign-up, the reset link, the signed-in change) and by the forms that mirror the refusal before
 * the request goes out. ONE constant: the server enforces it (user-server `PasswordRules`), the
 * client repeats its sentence (user-ui `AuthValidation`, a consumer's change-password form).
 *
 * The rule is length alone — no composition classes: NIST SP 800-63B §5.1.1.2 discourages them
 * (they lower usability without raising strength). The server adds the one check a client cannot
 * make without the list: a password among the most common ones is refused with {@link TOO_COMMON}.
 */
export class PasswordPolicy {
  /** The fewest characters a password may have. */
  static readonly MIN_LENGTH = 8;
  /** What a too-short password is told, on the client and from the server alike. */
  static readonly TOO_SHORT = `Use at least ${PasswordPolicy.MIN_LENGTH} characters`;
  /** What a password on the common-passwords list is told (the server's check; a client passes it through). */
  static readonly TOO_COMMON = 'That password is too common';

  /** The refusal a password earns by its length alone, or undefined when it is long enough. */
  static tooShort(password: string): string | undefined {
    return password.length < PasswordPolicy.MIN_LENGTH ? PasswordPolicy.TOO_SHORT : undefined;
  }

  /** Whether `message` is one of this policy's refusals — a client shows it as it is, never as its own failure. */
  static isRefusal(message: string | undefined): boolean {
    return message === PasswordPolicy.TOO_SHORT || message === PasswordPolicy.TOO_COMMON;
  }
}
