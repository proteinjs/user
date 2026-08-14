import React from 'react';
import { Typography } from '@mui/material';

/** Inline form-level error line, rendered between the fields and the primary action. */
export function AuthFormError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }

  return (
    <Typography role='alert' sx={{ color: 'error.main', fontSize: '0.875rem', lineHeight: 1.45, mb: 2 }}>
      {message}
    </Typography>
  );
}
