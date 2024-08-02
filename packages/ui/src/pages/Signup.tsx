import React, { useEffect, useState } from 'react';
import { Page, Form, Fields, textField, FormButtons, clearButton, FormPage } from '@proteinjs/ui';
import { getInviteService, routes } from '@proteinjs/user';
import { Button, Skeleton, Stack, Typography } from '@mui/material';

const SignupComponent: React.FC = () => {
  const [token, setToken] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const buttons: FormButtons<SignupFields> = {
    clear: clearButton,
    signup: {
      name: 'Sign up',
      style: {
        color: 'primary',
        variant: 'contained',
      },
      onClick: async (fields: SignupFields, buttons: FormButtons<SignupFields>) => {
        const response = await fetch(routes.createUser.path, {
          method: routes.createUser.method,
          body: JSON.stringify({
            name: fields.name.field.value,
            email: fields.email.field.value,
            password: fields.password.field.value,
          }),
          redirect: 'follow',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
          },
        });
        if (response.status != 200) {
          throw new Error(`Failed to sign up, error: ${response.statusText}`);
        }

        const body = await response.json();
        if (body.error) {
          throw new Error(body.error);
        }

        return `Successfully created your account! Please check your email for an email confirmation.`;
      },
    },
  };

  useEffect(() => {
    // veronica todo: read the configuration from the consumer to know what to do here
    const searchParams = new URLSearchParams(window.location.search);
    const inviteToken = searchParams.get('token');
    if (inviteToken) {
      setToken(inviteToken);
      validateToken(inviteToken);
    } else {
      setValidationError('No sign up token provided.');
    }
  }, []);

  const validateToken = async (token: string) => {
    setIsValidating(true);
    try {
      const result = await getInviteService().isTokenValid(token);
      if (!result) {
        setValidationError('Invalid or expired token.');
      }
    } catch (error) {
      setValidationError('An error occurred while validating the token.');
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <FormPage>
      {/* // veronica todo: read the configuration from the consumer to know what to do here
    // if invite only, then disable the page if there is no token provided
    // if invite closed, then don't do any token validation or processing */}
      {isValidating ? (
        <Skeleton variant='rounded' width={300} height={100} />
      ) : validationError ? (
        <Stack alignItems='center' spacing={3}>
          <Typography variant='h1' gutterBottom>
            Invalid invite link
          </Typography>
          <Typography variant='body1' gutterBottom>
            The invite link is invalid or has expired.
          </Typography>
          <Button variant='contained' color='primary' href='/login'>
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
          }}
        />
      )}
    </FormPage>
  );
};

export const signupPath = 'signup';
export const signupPage: Page = {
  name: 'Sign Up',
  path: signupPath,
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
