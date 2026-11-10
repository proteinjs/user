import { PasswordPolicy } from '@proteinjs/user';
import { CommonPasswords } from './CommonPasswords';

/**
 * The server's judgment of a new password — the one check every door that takes one runs
 * before it is hashed: sign-up (`routes/signup`), the reset link (`routes/executePasswordReset`)
 * and the signed-in change (`UpdateUserInfo.updatePassword`). The length rule is
 * `PasswordPolicy`'s (shared with the forms, which mirror its sentence); the common-passwords
 * check is the server's alone — the forms show its sentence as it comes back.
 */
export class PasswordRules {
  /** The refusal `password` earns, or undefined when it may be set: too short first, then too common. */
  check(password: string): string | undefined {
    return PasswordPolicy.tooShort(password) ?? (CommonPasswords.has(password) ? PasswordPolicy.TOO_COMMON : undefined);
  }
}
