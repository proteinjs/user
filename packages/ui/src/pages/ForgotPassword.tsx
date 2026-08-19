import React, { useState } from 'react';
import { Box, Link } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { uiRoutes } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthMessagePanel } from '../auth/AuthMessagePanel';
import { AuthApi } from '../auth/AuthApi';

const ForgotPasswordComponent: React.FC = () => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await new AuthApi().initiatePasswordReset(email);
      setSent(true);
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthMessagePanel
        title='Check your email'
        body='We sent an email with a link to reset your password.'
        actionName='Back to log in'
        actionHref={`/${uiRoutes.auth.login}`}
      />
    );
  }

  return (
    <>
      <Helmet>
        <title>Reset your password</title>
      </Helmet>
      <AuthLayout
        title='Reset your password'
        subtitle={`Enter your email and we'll send you a link to reset your password.`}
      >
        <form onSubmit={onSubmit} noValidate>
          {/* Same identifier token as login ('username'), so the password manager fills the
              stored username here too. */}
          <AuthTextField
            label='Email'
            value={email}
            onChange={setEmail}
            type='email'
            autoComplete='username'
            disabled={busy}
          />
          <AuthFormError message={error} />
          <AuthButton busy={busy}>Send reset link</AuthButton>
        </form>
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Link
            href={`/${uiRoutes.auth.login}`}
            underline='hover'
            sx={{ fontSize: '0.875rem', color: 'text.secondary', py: '13px', px: 2 }}
          >
            Back to log in
          </Link>
        </Box>
      </AuthLayout>
    </>
  );
};

export const forgotPasswordPage: Page = {
  name: 'Forgot Password',
  path: uiRoutes.auth.forgotPassword,
  auth: {
    public: true,
  },
  component: ForgotPasswordComponent,
};
