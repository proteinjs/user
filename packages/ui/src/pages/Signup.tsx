import React, { useEffect, useState } from 'react';
import { Skeleton, Stack } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { getSignupService, uiRoutes } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthMessagePanel } from '../auth/AuthMessagePanel';
import { AuthFieldErrors, AuthValidation } from '../auth/AuthValidation';
import { AuthApi } from '../auth/AuthApi';
import { AuthFormFields } from '../auth/AuthFormFields';

type SignupField = 'name' | 'email' | 'password' | 'confirmPassword';

function inviteTokenFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URLSearchParams(window.location.search).get('token') || '';
}

const SignupComponent: React.FC = () => {
  const [token] = useState(inviteTokenFromUrl);
  const [initializing, setInitializing] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<SignupField>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    getSignupService()
      .initializeSignup(token || undefined)
      .then((response) => {
        if (!active) {
          return;
        }
        if (!response.isReady && response.error) {
          setInitializationError(response.error);
        } else if (response.invite) {
          setInviteEmail(response.invite.email);
        }
      })
      .catch(() => {
        if (active) {
          setInitializationError('An error occurred while initializing sign up.');
        }
      })
      .finally(() => {
        if (active) {
          setInitializing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  const clearFieldError = (name: SignupField) =>
    setFieldErrors((errors) => (errors[name] ? { ...errors, [name]: undefined } : errors));

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Read from the form at submit: a password manager's suggested password (or any autofill)
    // may be in the DOM only. The invite path carries no email field; its read is ''.
    const form = event.currentTarget;
    const { name, email, password, confirmPassword } = AuthFormFields.read(form, [
      'name',
      'email',
      'password',
      'confirmPassword',
    ] as const);
    const invalid = AuthValidation.signup({ name, email, password, confirmPassword }, !!token);
    setFieldErrors(invalid ?? {});
    if (invalid) {
      AuthFormFields.focusFirstInvalid(form, invalid);
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      // invited users don't enter an email (the invite token carries it); the request also
      // establishes the session (auto-login)
      await new AuthApi().signup({ name, email: token ? undefined : email.trim(), password }, token || undefined);
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // Full navigation, not a router transition: the fresh page load renders under the
    // just-established session, landing the new user in the app — never on the login form.
    window.location.href = '/';
  };

  if (initializing) {
    return (
      <AuthLayout title='Create your account'>
        <Stack spacing={2.5}>
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '12px' }} />
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '12px' }} />
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '12px' }} />
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '999px' }} />
        </Stack>
      </AuthLayout>
    );
  }

  if (initializationError) {
    return (
      <AuthMessagePanel
        title='Sign up is not available'
        body={initializationError}
        actionName='Go to log in'
        actionHref={`/${uiRoutes.auth.login}`}
      />
    );
  }

  return (
    <>
      <Helmet>
        <title>Sign up</title>
      </Helmet>
      <AuthLayout title='Create your account'>
        <form onSubmit={onSubmit} noValidate>
          <AuthTextField
            label='Name'
            name='name'
            onChange={() => clearFieldError('name')}
            error={fieldErrors.name}
            autoComplete='name'
            disabled={busy}
          />
          {token ? (
            // The invite fixes the email; render it read-only, tagged as the username. Without
            // an email field here, password managers captured the NAME field as the saved
            // credential's username — which then autofilled the login email field and failed.
            <AuthTextField label='Email' value={inviteEmail} type='email' autoComplete='username' readOnly />
          ) : (
            // 'username' (not 'email'): this is the credential identifier password managers
            // save and fill; type='email' still gives the email keyboard.
            <AuthTextField
              label='Email'
              name='email'
              onChange={() => clearFieldError('email')}
              error={fieldErrors.email}
              type='email'
              autoComplete='username'
              disabled={busy}
            />
          )}
          <AuthTextField
            label='Password'
            name='password'
            onChange={() => clearFieldError('password')}
            error={fieldErrors.password}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          <AuthTextField
            label='Confirm password'
            name='confirmPassword'
            onChange={() => clearFieldError('confirmPassword')}
            error={fieldErrors.confirmPassword}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          <AuthFormError message={error} />
          <AuthButton busy={busy}>Sign up</AuthButton>
        </form>
      </AuthLayout>
    </>
  );
};

export const signupPage: Page = {
  name: 'Sign Up',
  path: uiRoutes.auth.signup,
  auth: {
    public: true,
  },
  component: SignupComponent,
};
