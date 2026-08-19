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
import { AuthValidation } from '../auth/AuthValidation';
import { AuthApi } from '../auth/AuthApi';

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
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    getSignupService()
      .initializeSignup(token || undefined)
      .then((response) => {
        if (active && !response.isReady && response.error) {
          setInitializationError(response.error);
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

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = AuthValidation.signup({ name, email, password, confirmPassword }, !!token);
    if (validationError) {
      setError(validationError);
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
          <AuthTextField label='Name' value={name} onChange={setName} autoComplete='name' disabled={busy} />
          {!token && (
            <AuthTextField
              label='Email'
              value={email}
              onChange={setEmail}
              type='email'
              autoComplete='email'
              disabled={busy}
            />
          )}
          <AuthTextField
            label='Password'
            value={password}
            onChange={setPassword}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          <AuthTextField
            label='Confirm password'
            value={confirmPassword}
            onChange={setConfirmPassword}
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
