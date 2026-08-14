import React from 'react';
import { Box } from '@mui/material';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';

export interface AuthMessagePanelProps {
  title: string;
  body: string;
  actionName: string;
  actionHref: string;
}

/**
 * Status states of the auth flows (link expired, reset complete, signup unavailable):
 * a title, one line of body copy, and a single primary action.
 */
export function AuthMessagePanel(props: AuthMessagePanelProps) {
  const { title, body, actionName, actionHref } = props;
  return (
    <AuthLayout title={title} subtitle={body}>
      <Box sx={{ mt: 1 }}>
        <AuthButton type='button' href={actionHref}>
          {actionName}
        </AuthButton>
      </Box>
    </AuthLayout>
  );
}
