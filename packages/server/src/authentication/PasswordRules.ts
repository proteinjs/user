import { PasswordPolicy, PasswordRefusal } from '@proteinjs/user';
import { CommonPasswords } from './CommonPasswords';

/**
 * The server's judgment of a new password — the one check every door that takes one runs
 * before it is hashed: sign-up (`routes/signup`), the reset link (`routes/executePasswordReset`)
 * and the signed-in change (`UpdateUserInfo.updatePassword`). The length rule is
 * `PasswordPolicy`'s (shared with the forms, which mirror its sentence); the common-passwords
 * check is the server's alone — the forms show its sentence as it comes back.
 *
 * What arrives is whatever the request carried, so the check takes it untyped: a value that is no
 * text at all (a JSON number, an object, nothing) is refused here as blank, before any rule reads
 * it — on every road that hands this check a password, present or future, never a failure inside
 * the rules. Every refusal is a `PasswordRefusal` — a sentence on `PasswordPolicy.REFUSALS`, the
 * list `PasswordPolicy.isRefusal` reads (the blank one included) — so a form that asks it shows each
 * as it is, and a rule answering a sentence off that list does not compile.
 */
export class PasswordRules {
  /** The refusal `password` earns, or undefined when it may be set: blank (or not text) first, then too short, then too common. */
  check(password: unknown): PasswordRefusal | undefined {
    if (!PasswordRules.isGiven(password)) {
      return PasswordPolicy.BLANK;
    }

    return PasswordPolicy.tooShort(password) ?? (CommonPasswords.has(password) ? PasswordPolicy.TOO_COMMON : undefined);
  }

  /**
   * Whether `password` is text with something in it — the test `check` holds every road to first.
   * A door that answers a blank field in its own sentence (sign-up names both of its fields in
   * one) reads this rather than repeating it.
   */
  static isGiven(password: unknown): password is string {
    return typeof password === 'string' && password.length > 0;
  }
}
