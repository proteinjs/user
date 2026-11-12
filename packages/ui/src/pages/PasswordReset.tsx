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
import { AuthFormFields } from '../auth/AuthFormFields';
import { AuthFieldErrors, AuthValidation } from '../auth/AuthValidation';

type PasswordResetField = 'newPassword' | 'confirmPassword';

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
  // The check refused by the limit in front of the door: no verdict on the link at all.
  const [limited, setLimited] = useState(false);
  const [email, setEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<PasswordResetField>>({});
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
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        if (AuthApi.isTooManyAttempts(error)) {
          setLimited(true);
        } else {
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

  const clearFieldError = (name: PasswordResetField) =>
    setFieldErrors((errors) => (errors[name] ? { ...errors, [name]: undefined } : errors));

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Read from the form at submit: a suggested or saved password may be in the DOM only.
    const form = event.currentTarget;
    const { newPassword, confirmPassword } = AuthFormFields.read(form, ['newPassword', 'confirmPassword'] as const);
    const invalid = AuthValidation.passwordReset({ newPassword, confirmPassword });
    setFieldErrors(invalid ?? {});
    if (invalid) {
      AuthFormFields.focusFirstInvalid(form, invalid);
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

  if (limited) {
    // The limit refused the check, so the link was never judged: the person reads the limit's words
    // and tries the same link again — never told a live link is dead.
    return (
      <AuthMessagePanel
        title='Reset your password'
        body={AuthApi.TOO_MANY_ATTEMPTS}
        actionName='Try again'
        actionHref={`/${uiRoutes.auth.passwordReset}?token=${encodeURIComponent(token)}`}
      />
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
            name='newPassword'
            onChange={() => clearFieldError('newPassword')}
            error={fieldErrors.newPassword}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          <AuthTextField
            label='Confirm new password'
            name='confirmPassword'
            onChange={() => clearFieldError('confirmPassword')}
            error={fieldErrors.confirmPassword}
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
