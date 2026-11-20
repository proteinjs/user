import React, { useEffect, useState } from 'react';
import { Box, Skeleton, Stack, Typography } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { getSignupService, SIGNUP_CLOSED_SENTENCE, uiRoutes, UserAuth } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { Navigate } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthMessagePanel } from '../auth/AuthMessagePanel';
import { AuthFieldErrors, AuthValidation } from '../auth/AuthValidation';
import { AuthApi } from '../auth/AuthApi';
import { AuthFormFields } from '../auth/AuthFormFields';
import { SignInPageFacts } from '../auth/SignInPageFacts';
import { AuthPageProducts } from '../auth/AuthPageProduct';
import { AuthQuietLink } from '../auth/AuthQuietLink';

type SignupField = 'name' | 'email' | 'password' | 'confirmPassword';

function inviteTokenFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URLSearchParams(window.location.search).get('token') || '';
}

/**
 * Without an invite the page renders at once from what the server wrote into the page at load
 * (SignInPageFacts): the form where sign-up is open, the closed panel where it is not, with no call and
 * nothing gray first; a signed-in person is on Home instead. An invite link keeps its own road
 * (InvitedSignup): the invite is checked on load.
 */
const SignupComponent: React.FC = () => {
  const [token] = useState(inviteTokenFromUrl);
  if (token) {
    return <InvitedSignup token={token} />;
  }
  // A signed-in person never sees this page (an invite link is the one exception, as before): Home replaces it.
  if (UserAuth.isLoggedIn()) {
    return <Navigate to='/' replace />;
  }
  if (!SignInPageFacts.signupOpen()) {
    return <SignupClosedPanel body={AuthPageProducts.registered()?.signupClosedSentence ?? SIGNUP_CLOSED_SENTENCE} />;
  }
  return <SignupForm token='' inviteEmail='' />;
};

/** An invite link: the invite is checked on load (four gray bars while it is), then the form with its address fixed. */
const InvitedSignup: React.FC<{ token: string }> = ({ token }) => {
  const [initializing, setInitializing] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');

  useEffect(() => {
    let active = true;
    getSignupService()
      .initializeSignup(token || undefined)
      .then((response) => {
        if (!active) {
          return;
        }
        if (!response.isReady && response.error) {
          setInitializationError(response.error);
        } else if (response.invite) {
          setInviteEmail(response.invite.email);
        }
      })
      .catch(() => {
        if (active) {
          setInitializationError('An error occurred while initializing sign up.');
        }
      })
      .finally(() => {
        if (active) {
          setInitializing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  if (initializing) {
    return (
      <AuthLayout title='Create your account'>
        <Stack spacing={2.5}>
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '12px' }} />
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '12px' }} />
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '12px' }} />
          <Skeleton variant='rounded' height={48} sx={{ borderRadius: '999px' }} />
        </Stack>
      </AuthLayout>
    );
  }

  if (initializationError) {
    return <SignupClosedPanel body={initializationError} />;
  }

  return <SignupForm token={token} inviteEmail={inviteEmail} />;
};

/** The panel for a sign-up that cannot go on: a sentence and the way back to Log in. */
const SignupClosedPanel: React.FC<{ body: string }> = ({ body }) => (
  <AuthMessagePanel
    title='Sign up is not available'
    body={body}
    actionName='Go to log in'
    actionHref={`/${uiRoutes.auth.login}`}
  />
);

/**
 * The sign-up form. Without an invite (the sign-up plan's drawing F3): Email and Password, the product's sentence
 * above Sign up, and "Have an account? Log in" under it; the account is made with an empty name. With an invite's
 * token, as before: Name, the invite's address shown and fixed, Password and Confirm password.
 */
const SignupForm: React.FC<{ token: string; inviteEmail: string }> = ({ token, inviteEmail }) => {
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<SignupField>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const AgreementSentence = AuthPageProducts.registered()?.signupAgreementSentence;

  const clearFieldError = (name: SignupField) =>
    setFieldErrors((errors) => (errors[name] ? { ...errors, [name]: undefined } : errors));

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Read from the form at submit: a password manager's suggested password (or any autofill)
    // may be in the DOM only. The invite path carries no email field and the form without an invite
    // no name or second password; a field the form does not carry reads ''.
    const form = event.currentTarget;
    const { name, email, password, confirmPassword } = AuthFormFields.read(form, [
      'name',
      'email',
      'password',
      'confirmPassword',
    ] as const);
    const invalid = AuthValidation.signup({ name, email, password, confirmPassword }, !!token);
    setFieldErrors(invalid ?? {});
    if (invalid) {
      AuthFormFields.focusFirstInvalid(form, invalid);
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      // invited users don't enter an email (the invite token carries it); the request also
      // establishes the session (auto-login)
      await new AuthApi().signup(token ? { name, password } : { email: email.trim(), password }, token || undefined);
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // Full navigation, not a router transition: the fresh page load renders under the
    // just-established session, landing the new user in the app — never on the login form.
    // REPLACE, not assign: the signup page leaves history rather than sitting one back-forward
    // entry behind home, where a signed-in user's back gesture from a route the app pushed after
    // home could land on it. Replacing it makes home the base of their history.
    window.location.replace('/');
  };

  return (
    <>
      <Helmet>
        <title>Sign up</title>
      </Helmet>
      <AuthLayout title='Create your account'>
        <form onSubmit={onSubmit} noValidate>
          {token && (
            <AuthTextField
              label='Name'
              name='name'
              onChange={() => clearFieldError('name')}
              error={fieldErrors.name}
              autoComplete='name'
              disabled={busy}
            />
          )}
          {token ? (
            // The invite fixes the email; render it read-only, tagged as the username. Without
            // an email field here, password managers captured the NAME field as the saved
            // credential's username — which then autofilled the login email field and failed.
            <AuthTextField label='Email' value={inviteEmail} type='email' autoComplete='username' readOnly />
          ) : (
            // 'username' (not 'email'): this is the credential identifier password managers
            // save and fill; type='email' still gives the email keyboard.
            <AuthTextField
              label='Email'
              name='email'
              onChange={() => clearFieldError('email')}
              error={fieldErrors.email}
              type='email'
              autoComplete='username'
              disabled={busy}
            />
          )}
          <AuthTextField
            label='Password'
            name='password'
            onChange={() => clearFieldError('password')}
            error={fieldErrors.password}
            password
            autoComplete='new-password'
            disabled={busy}
          />
          {token && (
            <AuthTextField
              label='Confirm password'
              name='confirmPassword'
              onChange={() => clearFieldError('confirmPassword')}
              error={fieldErrors.confirmPassword}
              password
              autoComplete='new-password'
              disabled={busy}
            />
          )}
          {!token && AgreementSentence && (
            <Typography
              component='p'
              sx={{ m: 0, mt: '6px', mb: '22px', fontSize: '0.875rem', lineHeight: '20px', color: 'text.secondary' }}
            >
              <AgreementSentence />
            </Typography>
          )}
          <AuthFormError message={error} />
          <AuthButton busy={busy}>Sign up</AuthButton>
        </form>
        {!token && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <AuthQuietLink href={`/${uiRoutes.auth.login}`}>Have an account? Log in</AuthQuietLink>
          </Box>
        )}
      </AuthLayout>
    </>
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
