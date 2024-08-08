import React, { useEffect, useState } from 'react';
import { Page, Form, Fields, textField, FormButtons, clearButton, FormPage } from '@proteinjs/ui';
import { getSignupService, uiRoutes } from '@proteinjs/user';
import { Button, Skeleton, Stack, Typography } from '@mui/material';
import { emailRegex } from '@proteinjs/util';

const SignupComponent: React.FC = () => {
  const [token, setToken] = useState('');
  const [isInviteOnly, setIsInviteOnly] = useState<boolean>(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  const buttons: FormButtons<SignupFields> = {
    clear: clearButton,
    signup: {
      name: 'Sign up',
      style: {
        color: 'primary',
        variant: 'contained',
      },
      onClick: async (fields: SignupFields, buttons: FormButtons<SignupFields>) => {
        if (!fields.name.field.value) {
          return 'Please enter your name.';
        }

        const email = fields.email.field.value && fields.email.field.value.trim();

        // invited users don't enter an email
        if (!token && (!email || !emailRegex.test(email))) {
          return 'Please enter a valid email address.';
        }

        if (!fields.password.field.value) {
          return 'Please enter a password.';
        }

        try {
          await getSignupService().createUser(
            {
              name: fields.name.field.value,
              email,
              password: fields.password.field.value,
            },
            token
          );
        } catch {
          return 'Sign up failed.';
        }

        return `Successfully created your account! Please check your email for an email confirmation.`;
      },
    },
  };

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const inviteToken = searchParams.get('token');
    if (inviteToken) {
      setToken(inviteToken);
      initializeSignup(inviteToken);
    } else {
      initializeSignup();
    }
  }, []);

  const initializeSignup = async (token?: string) => {
    setIsInitializing(true);
    try {
      const response = await getSignupService().initializeSignup(token);

      if (response.isInviteOnly !== undefined) {
        setIsInviteOnly(response.isInviteOnly);
      }

      if (!response.isReady && response.error) {
        setInitializationError(response.error);
      }
    } catch (error) {
      setInitializationError('An error occurred while initializing sign up.');
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <FormPage>
      {isInitializing ? (
        <Stack direction='column' spacing={2} sx={{ px: 2, py: 1 }}>
          <Skeleton variant='text' width='500px' height='60px' />
          <Skeleton variant='text' width='500px' height='60px' />
          <Skeleton variant='text' width='500px' height='60px' />
          <Skeleton variant='text' width='500px' height='60px' />
          <Stack direction='row' spacing={2} justifyContent='flex-end'>
            <Skeleton variant='text' width='100px' height='60px' />
            <Skeleton variant='text' width='100px' height='60px' />
          </Stack>
        </Stack>
      ) : initializationError ? (
        <Stack alignItems='center' spacing={3} sx={{ p: 4 }}>
          <Typography variant='h1' gutterBottom>
            Sign up is not available
          </Typography>
          <Typography variant='body1' gutterBottom>
            {initializationError}
          </Typography>
          <Button variant='contained' color='primary' href={`/${uiRoutes.auth.login}`}>
            Go to login page
          </Button>
        </Stack>
      ) : (
        <Form<SignupFields, typeof buttons>
          name='Sign Up'
          createFields={() => new SignupFields()}
          fieldLayout={['name', 'email', 'password', 'confirmPassword']}
          buttons={buttons}
          onLoad={async (fields) => {
            fields.token.field.value = token;
            if (token) {
              fields.email.field.accessibility = { hidden: true };
            }
          }}
        />
      )}
    </FormPage>
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

class SignupFields extends Fields {
  static create() {
    return new SignupFields();
  }

  token = textField<SignupFields>({
    name: 'token',
    accessibility: { hidden: true },
  });

  name = textField<SignupFields>({
    name: 'name',
  });

  email = textField<SignupFields>({
    name: 'email',
  });

  password = textField<SignupFields>({
    name: 'password',
    isPassword: true,
  });

  confirmPassword = textField<SignupFields>({
    name: 'confirmPassword',
    isPassword: true,
  });
}
