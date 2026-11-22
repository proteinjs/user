import React from 'react';
import { Link } from '@mui/material';

/**
 * A quiet line under a sign-in form ("Forgot password?", "New here? Create your account", "Have an account?
 * Log in"): 0.875rem in the secondary text color, with a 44px tap target and no visual bulk. The one place the
 * log-in and sign-up pages read that style. A line that must do something before it leaves (the
 * confirmation screen's "Log out" ends the session first) hands an `onClick`; its `href` stays the address
 * it leads to.
 */
export const AuthQuietLink: React.FC<{
  href: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  children: React.ReactNode;
}> = ({ href, onClick, children }) => (
  <Link
    href={href}
    onClick={onClick}
    underline='hover'
    sx={{ fontSize: '0.875rem', color: 'text.secondary', py: '13px', px: 2 }}
  >
    {children}
  </Link>
);
