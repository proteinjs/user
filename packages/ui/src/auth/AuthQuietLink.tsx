import React from 'react';
import { Link } from '@mui/material';

/**
 * A quiet line under a sign-in form ("Forgot password?", "New here? Create your account", "Have an account?
 * Log in"): 0.875rem in the secondary text color, with a 44px tap target and no visual bulk. The one place the
 * log-in and sign-up pages read that style.
 */
export const AuthQuietLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <Link href={href} underline='hover' sx={{ fontSize: '0.875rem', color: 'text.secondary', py: '13px', px: 2 }}>
    {children}
  </Link>
);
