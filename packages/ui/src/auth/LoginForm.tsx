import React, { useState } from 'react';
import { AuthTextField } from './AuthTextField';
import { AuthButton } from './AuthButton';
import { AuthFormError } from './AuthFormError';
import { AuthApi } from './AuthApi';
import { AuthFormFields } from './AuthFormFields';
import { AuthFieldErrors, AuthValidation } from './AuthValidation';

type LoginField = 'email' | 'password';

/**
 * The log-in form: Email, Password, the form's own error line and Log in. The one form every page that
 * logs a person in renders: the log-in page, and the email confirmation's page under its own title.
 *
 * `destination` is the address loaded once the log-in has made the session. LOADED ANEW, replacing this
 * page in history: a full navigation (the fresh load renders under the just-established session), but
 * it replaces the page that holds the form rather than pushing the destination on top of it. Left in
 * history, that page sits one back-forward entry behind the destination, and a signed-in person's back
 * gesture from a route the app pushed afterwards can land on it — a page a signed-in person can never
 * be on. Replacing it makes the destination the base of their history.
 */
export function LoginForm({ destination }: { destination: string }) {
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<LoginField>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const clearFieldError = (name: LoginField) =>
    setFieldErrors((errors) => (errors[name] ? { ...errors, [name]: undefined } : errors));

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The fields' values as they are NOW, read from the form — a password manager or autofill
    // that wrote a field without an input event is only in the DOM (AuthFormFields).
    const form = event.currentTarget;
    const { email, password } = AuthFormFields.read(form, ['email', 'password'] as const);
    const invalid = AuthValidation.login({ email, password });
    setFieldErrors(invalid ?? {});
    if (invalid) {
      AuthFormFields.focusFirstInvalid(form, invalid);
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      await new AuthApi().login(email.trim(), password);
      window.location.replace(destination);
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      {/* 'username' (not 'email'): this is the credential identifier password managers
          fill from the saved login; type='email' still gives the email keyboard. */}
      <AuthTextField
        label='Email'
        name='email'
        onChange={() => clearFieldError('email')}
        error={fieldErrors.email}
        type='email'
        autoComplete='username'
        disabled={busy}
      />
      <AuthTextField
        label='Password'
        name='password'
        onChange={() => clearFieldError('password')}
        error={fieldErrors.password}
        password
        autoComplete='current-password'
        disabled={busy}
      />
      <AuthFormError message={error} />
      <AuthButton busy={busy}>Log in</AuthButton>
    </form>
  );
}
