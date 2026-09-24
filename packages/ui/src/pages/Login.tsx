import React, { useState } from 'react';
import { Box, Link, Typography } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { uiRoutes } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { useLocation } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthApi } from '../auth/AuthApi';
import { AuthFormFields } from '../auth/AuthFormFields';
import { AuthFieldErrors, AuthValidation } from '../auth/AuthValidation';

type LoginField = 'email' | 'password';

/**
 * What a navigation to the login page may carry in the router's location state: one plain sentence
 * for the person arriving (e.g. why they were just signed out), rendered in the page's message seat
 * above the fields. The state key is this page's API; anything that is not a non-empty string is no
 * message.
 */
export type LoginLocationState = { message?: string };

function arrivalMessage(state: unknown): string | undefined {
  const message = (state as LoginLocationState | null | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

const LoginComponent: React.FC = () => {
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<LoginField>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const message = arrivalMessage(useLocation().state);

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
      window.location.href = '/';
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
    }
  };

  return (
    <>
      <Helmet>
        <title>Log in</title>
      </Helmet>
      <AuthLayout title='Log in'>
        {message && (
          // The message seat: one inset above the fields, on the theme's quiet tint, announced politely.
          <Typography
            role='status'
            sx={{
              mb: '22px',
              px: '14px',
              py: '12px',
              borderRadius: '12px',
              backgroundColor: 'action.hover',
              fontSize: '0.875rem',
              lineHeight: '20px',
              color: 'text.primary',
            }}
          >
            {message}
          </Typography>
        )}
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
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Link
            href={`/${uiRoutes.auth.forgotPassword}`}
            underline='hover'
            sx={{
              fontSize: '0.875rem',
              color: 'text.secondary',
              // 44px touch target without visual bulk.
              py: '13px',
              px: 2,
            }}
          >
            Forgot password?
          </Link>
        </Box>
      </AuthLayout>
    </>
  );
};

export const loginPage: Page = {
  name: 'Login',
  path: uiRoutes.auth.login,
  auth: {
    public: true,
  },
  component: LoginComponent,
};
