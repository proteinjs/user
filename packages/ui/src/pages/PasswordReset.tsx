import React, { useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { uiRoutes } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthMessagePanel } from '../auth/AuthMessagePanel';
import { AuthApi } from '../auth/AuthApi';
import { AuthValidation } from '../auth/AuthValidation';

function resetTokenFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URLSearchParams(window.location.search).get('token') || '';
}

const PasswordResetComponent: React.FC = () => {
  // The token is read synchronously so the first paint is already the right state
  // (validating vs invalid) — never a flash of the form for a dead link.
  const [token] = useState(resetTokenFromUrl);
  const [validating, setValidating] = useState(!!token);
  const [invalid, setInvalid] = useState(!token);
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [resetComplete, setResetComplete] = useState(false);

  useEffect(() => {
    if (!token) {
      return;
    }

    let active = true;
    new AuthApi()
      .validateResetToken(token)
      .then((result) => {
        if (!active) {
          return;
        }
        if (result.valid) {
          setEmail(result.email);
        } else {
          setInvalid(true);
        }
      })
      .catch(() => {
        if (active) {
          setInvalid(true);
        }
      })
      .finally(() => {
        if (active) {
          setValidating(false);
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = AuthValidation.passwordReset({ newPassword, confirmPassword });
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      await new AuthApi().executePasswordReset(token, newPassword);
      setResetComplete(true);
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
    }
  };

  if (validating) {
    return (
      <AuthLayout title='Reset your password'>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.secondary' }}>
          <CircularProgress size={18} sx={{ color: 'inherit' }} />
          <Typography sx={{ fontSize: '0.875rem', color: 'inherit' }}>Checking your reset link…</Typography>
        </Box>
      </AuthLayout>
    );
  }

  if (invalid) {
    return (
      <AuthMessagePanel
        title='This reset link is invalid'
        body='The link is invalid or has expired. Request a new one from the log in page.'
        actionName='Go to log in'
        actionHref={`/${uiRoutes.auth.login}`}
      />
    );
  }

  if (resetComplete) {
    return (
      <AuthMessagePanel
        title='Password reset'
        body='You can now log in with your new password.'
        actionName='Go to log in'
        actionHref={`/${uiRoutes.auth.login}`}
      />
    );
  }

  return (
    <>
      <Helmet>
        <title>Reset your password</title>
      </Helmet>
      <AuthLayout title='Choose a new password'>
        <form onSubmit={onSubmit} noValidate>
          {/* The account the reset is for, read-only and tagged `username`: without an
              identifier field, password managers can't associate the new password with the
              stored credential (read-only, not disabled — managers ignore disabled inputs). */}
          <AuthTextField label='Email' value={email} type='email' autoComplete='username' readOnly />
          <AuthTextField
            label='New password'
            value={newPassword}
            onChange={setNewPassword}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          <AuthTextField
            label='Confirm new password'
            value={confirmPassword}
            onChange={setConfirmPassword}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          <AuthFormError message={error} />
          <AuthButton busy={busy}>Reset password</AuthButton>
        </form>
      </AuthLayout>
    </>
  );
};

export const passwordResetPage: Page = {
  name: 'Reset Password',
  path: uiRoutes.auth.passwordReset,
  auth: {
    public: true,
  },
  component: PasswordResetComponent,
};
