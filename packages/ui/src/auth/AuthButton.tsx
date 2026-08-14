import React from 'react';
import { Button, CircularProgress } from '@mui/material';

export interface AuthButtonProps {
  children: React.ReactNode;
  /** Renders a spinner and disables the button. */
  busy?: boolean;
  /** Defaults to 'submit' so the enclosing form submits on Enter. */
  type?: 'submit' | 'button';
  href?: string;
  onClick?: () => void;
}

/** The auth surfaces' primary action: a full-width 48px pill in the host theme's primary color. */
export function AuthButton(props: AuthButtonProps) {
  const { children, busy, type, href, onClick } = props;
  return (
    <Button
      fullWidth
      variant='contained'
      color='primary'
      disableElevation
      type={type || 'submit'}
      disabled={busy}
      href={href}
      onClick={onClick}
      sx={{
        height: 48,
        borderRadius: '999px',
        fontSize: '1rem',
        fontWeight: 500,
        textTransform: 'none',
      }}
    >
      {busy ? <CircularProgress size={20} sx={{ color: 'inherit' }} /> : children}
    </Button>
  );
}
