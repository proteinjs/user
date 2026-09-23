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
import { AuthFormFields } from '../auth/AuthFormFields';
import { AuthFieldErrors, AuthValidation } from '../auth/AuthValidation';

const ForgotPasswordComponent: React.FC = () => {
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<'email'>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | undefined>();

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Read from the form at submit, like login: an autofilled email may be in the DOM only.
    const form = event.currentTarget;
    const { email } = AuthFormFields.read(form, ['email'] as const);
    const invalid = AuthValidation.forgotPassword({ email });
    setFieldErrors(invalid ?? {});
    if (invalid) {
      AuthFormFields.focusFirstInvalid(form, invalid);
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      setAnswer(await new AuthApi().initiatePasswordReset(email.trim()));
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
    }
  };

  // The door's own sentence: it gives the same one for every address, so the page never claims
  // a mail was sent (it cannot know, and must not seem to).
  if (answer) {
    return (
      <AuthMessagePanel
        title='Check your email'
        body={answer}
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
            name='email'
            onChange={() => setFieldErrors((errors) => (errors.email ? {} : errors))}
            error={fieldErrors.email}
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
