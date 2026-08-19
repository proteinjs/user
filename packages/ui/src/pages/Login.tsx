import React, { useState } from 'react';
import { Box, Link } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { uiRoutes } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthApi } from '../auth/AuthApi';

const LoginComponent: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await new AuthApi().login(email, password);
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
        <form onSubmit={onSubmit} noValidate>
          {/* 'username' (not 'email'): this is the credential identifier password managers
              fill from the saved login; type='email' still gives the email keyboard. */}
          <AuthTextField
            label='Email'
            value={email}
            onChange={setEmail}
            type='email'
            autoComplete='username'
            disabled={busy}
          />
          <AuthTextField
            label='Password'
            value={password}
            onChange={setPassword}
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
