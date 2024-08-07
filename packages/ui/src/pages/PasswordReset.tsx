import React, { useEffect, useState } from 'react';
import { Page, Form, Fields, textField, FormButtons, FormPage } from '@proteinjs/ui';
import { routes, uiRoutes } from '@proteinjs/user';
import { Button, Stack, Typography } from '@mui/material';

const PasswordResetComponent: React.FC = () => {
  const [token, setToken] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);

  const buttons: FormButtons<ResetPasswordFields> = {
    submit: {
      name: 'Reset Password',
      style: {
        color: 'primary',
        variant: 'contained',
      },
      onClick: async (fields: ResetPasswordFields) => {
        if (fields.newPassword.field.value !== fields.confirmPassword.field.value) {
          throw new Error('Passwords do not match');
        }

        const response = await fetch(routes.executePasswordReset.path, {
          method: routes.executePasswordReset.method,
          body: JSON.stringify({
            token: fields.token.field.value,
            newPassword: fields.newPassword.field.value,
          }),
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (response.status !== 200) {
          throw new Error('Failed to reset password');
        }

        setResetSuccess(true);
        return 'Your password has been successfully reset. You can now log in with your new password.';
      },
    },
  };

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const resetToken = searchParams.get('token');
    if (resetToken) {
      setToken(resetToken);
      validateToken(resetToken);
    } else {
      setValidationError('No reset token provided');
    }
  }, []);

  const validateToken = async (token: string) => {
    setIsValidating(true);
    try {
      const response = await fetch(`${routes.validateResetToken.path}?token=${token}`, {
        method: routes.validateResetToken.method,
        credentials: 'same-origin',
      });
      const data = await response.json();
      if (!data.isValid) {
        setValidationError(data.message || 'Invalid or expired token');
      }
    } catch (error) {
      setValidationError('An error occurred while validating the token');
    } finally {
      setIsValidating(false);
    }
  };

  if (isValidating) {
    return <FormPage>Validating reset token...</FormPage>;
  }

  if (validationError) {
    return (
      <FormPage>
        <Stack alignItems='center' spacing={3}>
          <Typography variant='h1' gutterBottom>
            Invalid password reset link
          </Typography>
          <Typography variant='body1' gutterBottom>
            The password reset link is invalid or has expired. Please request a new password reset.
          </Typography>
          <Button variant='contained' color='primary' href={`/${uiRoutes.auth.login}`}>
            Go to login page
          </Button>
        </Stack>
      </FormPage>
    );
  }

  if (resetSuccess) {
    return (
      <FormPage>
        <Stack alignItems='center' spacing={3}>
          <Typography variant='h6' gutterBottom>
            Password reset successful
          </Typography>
          <Typography variant='body1' gutterBottom>
            Your password has been successfully reset. You can now log in with your new password.
          </Typography>
          <Button variant='contained' color='primary' href={`/${uiRoutes.auth.login}`}>
            Go to login page
          </Button>
        </Stack>
      </FormPage>
    );
  }

  return (
    <FormPage>
      <Form<ResetPasswordFields, typeof buttons>
        name='Reset Password'
        createFields={() => new ResetPasswordFields()}
        fieldLayout={['newPassword', 'confirmPassword']}
        buttons={buttons}
        onLoad={async (fields) => {
          fields.token.field.value = token;
        }}
      />
    </FormPage>
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

class ResetPasswordFields extends Fields {
  static create() {
    return new ResetPasswordFields();
  }

  token = textField<ResetPasswordFields>({
    name: 'token',
    accessibility: { hidden: true },
  });

  newPassword = textField<ResetPasswordFields>({
    name: 'New Password',
    isPassword: true,
  });

  confirmPassword = textField<ResetPasswordFields>({
    name: 'Confirm New Password',
    isPassword: true,
  });
}
