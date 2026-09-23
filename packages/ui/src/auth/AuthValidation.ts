import { emailRegex } from '@proteinjs/util';

/** A user-readable message per invalid field, keyed by the field's form name. */
export type AuthFieldErrors<F extends string> = { [K in F]?: string };

/**
 * Client-side validation for the auth flows. Each method returns the invalid fields with a
 * user-readable message each (the page marks those fields), or undefined when the input is
 * valid. A blank field is refused here, in the page, so a real form never sends one.
 */
export class AuthValidation {
  static login(fields: { email: string; password: string }): AuthFieldErrors<'email' | 'password'> | undefined {
    const errors: AuthFieldErrors<'email' | 'password'> = {};
    if (!fields.email.trim()) {
      errors.email = 'Enter your email';
    }

    if (!fields.password) {
      errors.password = 'Enter your password';
    }

    return AuthValidation.outcome(errors);
  }

  static forgotPassword(fields: { email: string }): AuthFieldErrors<'email'> | undefined {
    const errors: AuthFieldErrors<'email'> = {};
    if (!fields.email.trim()) {
      errors.email = 'Enter your email';
    }

    return AuthValidation.outcome(errors);
  }

  /** @param invited invited users don't enter an email (the invite token carries it) */
  static signup(
    fields: { name: string; email: string; password: string; confirmPassword: string },
    invited: boolean
  ): AuthFieldErrors<'name' | 'email' | 'password' | 'confirmPassword'> | undefined {
    const errors: AuthFieldErrors<'name' | 'email' | 'password' | 'confirmPassword'> = {};
    if (!fields.name.trim()) {
      errors.name = 'Enter your name';
    }

    if (!invited) {
      if (!fields.email.trim()) {
        errors.email = 'Enter your email';
      } else if (!emailRegex.test(fields.email.trim())) {
        errors.email = 'Enter a valid email address';
      }
    }

    if (!fields.password) {
      errors.password = 'Enter a password';
    } else if (fields.password !== fields.confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    return AuthValidation.outcome(errors);
  }

  static passwordReset(fields: {
    newPassword: string;
    confirmPassword: string;
  }): AuthFieldErrors<'newPassword' | 'confirmPassword'> | undefined {
    const errors: AuthFieldErrors<'newPassword' | 'confirmPassword'> = {};
    if (!fields.newPassword) {
      errors.newPassword = 'Enter a new password';
    } else if (fields.newPassword !== fields.confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    return AuthValidation.outcome(errors);
  }

  private static outcome<F extends string>(errors: AuthFieldErrors<F>): AuthFieldErrors<F> | undefined {
    return Object.keys(errors).length > 0 ? errors : undefined;
  }
}
