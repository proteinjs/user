import { emailRegex } from '@proteinjs/util';

/**
 * Client-side validation for the auth flows. Each method returns a user-readable
 * error message, or undefined when the input is valid.
 */
export class AuthValidation {
  /** @param invited invited users don't enter an email (the invite token carries it) */
  static signup(
    fields: { name: string; email: string; password: string; confirmPassword: string },
    invited: boolean
  ): string | undefined {
    if (!fields.name.trim()) {
      return 'Please enter your name.';
    }

    if (!invited && !emailRegex.test(fields.email.trim())) {
      return 'Please enter a valid email address.';
    }

    if (!fields.password) {
      return 'Please enter a password.';
    }

    if (fields.password !== fields.confirmPassword) {
      return 'Passwords do not match.';
    }
  }

  static passwordReset(fields: { newPassword: string; confirmPassword: string }): string | undefined {
    if (!fields.newPassword) {
      return 'Please enter a new password.';
    }

    if (fields.newPassword !== fields.confirmPassword) {
      return 'Passwords do not match.';
    }
  }
}
