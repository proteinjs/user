import React, { useEffect, useState } from 'react';
import { Page, Form, Fields, textField, FormButtons, FormPage } from '@proteinjs/ui';
import { routes } from '@proteinjs/user';

const PasswordResetComponent: React.FC = () => {
  const [token, setToken] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

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
      console.error('Error validating token:', error);
      setValidationError('An error occurred while validating the token');
    } finally {
      setIsValidating(false);
    }
  };

  if (isValidating) {
    return <FormPage>Validating reset token...</FormPage>;
  }

  if (validationError) {
    return <FormPage>{validationError}</FormPage>;
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

export const passwordResetPath = 'login/password-reset';
export const passwordResetPage: Page = {
  name: 'Reset Password',
  path: passwordResetPath,
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
        const body = await response.json();
        throw new Error(body.error || 'Failed to reset password');
      }

      // Optionally, you can redirect the user to the login page after successful password reset
      // window.location.href = '/login';

      return 'Your password has been successfully reset. You can now log in with your new password.';
    },
  },
};
