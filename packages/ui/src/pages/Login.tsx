import React from 'react';
import { Box, Typography } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { uiRoutes, UserAuth } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { LoginForm } from '../auth/LoginForm';
import { SignInPageFacts } from '../auth/SignInPageFacts';
import { AuthPageProducts } from '../auth/AuthPageProduct';
import { AuthQuietLink } from '../auth/AuthQuietLink';

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

/**
 * The line under "Forgot password?" that says how to get an account: the sign-up page where the page
 * says sign-up is open; the product's own line (AuthPageProduct) where it is closed; none when closed and
 * no product registered one.
 */
function newAccountLine(): { words: string; href: string } | undefined {
  if (SignInPageFacts.signupOpen()) {
    return { words: 'New here? Create your account', href: `/${uiRoutes.auth.signup}` };
  }
  return AuthPageProducts.registered()?.signupClosedLine;
}

const LoginComponent: React.FC = () => {
  const message = arrivalMessage(useLocation().state);
  const accountLine = newAccountLine();

  // A signed-in person never sees this page: Home replaces it before anything of the form renders.
  if (UserAuth.isLoggedIn()) {
    return <Navigate to='/' replace />;
  }

  return (
    <>
      <Helmet>
        <title>Log in</title>
      </Helmet>
      <AuthLayout title='Log in'>
        {message && (
          // The message seat: one inset above the fields, on the theme's quiet tint, announced politely.
          // Its ground is the theme's hover color at rest. A theme may paint `action.hover` only where a
          // pointer hovers (so a tap never leaves a hover stuck on a phone), and names the same color for
          // a ground at rest as `action.tint`: read when the theme has one, so the seat has its ground on
          // every pointer.
          <Typography
            role='status'
            sx={{
              mb: '22px',
              px: '14px',
              py: '12px',
              borderRadius: '12px',
              backgroundColor: (theme) =>
                (theme.palette.action as { tint?: string }).tint ?? theme.palette.action.hover,
              fontSize: '0.875rem',
              lineHeight: '20px',
              color: 'text.primary',
            }}
          >
            {message}
          </Typography>
        )}
        {/* The app's root, loaded anew under the session the log-in made (LoginForm). */}
        <LoginForm destination='/' />
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <AuthQuietLink href={`/${uiRoutes.auth.forgotPassword}`}>Forgot password?</AuthQuietLink>
        </Box>
        {accountLine && (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <AuthQuietLink href={accountLine.href}>{accountLine.words}</AuthQuietLink>
          </Box>
        )}
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
