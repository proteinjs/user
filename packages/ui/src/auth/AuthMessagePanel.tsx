import React from 'react';
import { Box } from '@mui/material';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { AuthTextField } from './AuthTextField';

export interface AuthMessagePanelProps {
  title: string;
  body: string;
  /**
   * The fixed value the message is ABOUT (e.g. the email a waitlist confirmation holds a spot
   * for) — rendered as a read-only auth field so the status page keeps the auth surfaces' form
   * column (title → field → action, the login page's grammar) instead of floating two text
   * lines over a lone full-width button.
   */
  field?: { label: string; value: string };
  actionName: string;
  actionHref: string;
}

/**
 * Status states of the auth flows (waitlist confirmations, link expired, reset complete,
 * signup unavailable): a title, one line of body copy, the optional fixed value the state is
 * about, and a single primary action — the same column and rhythm as the login form.
 */
export function AuthMessagePanel(props: AuthMessagePanelProps) {
  const { title, body, field, actionName, actionHref } = props;
  return (
    <AuthLayout title={title} subtitle={body}>
      {field ? <AuthTextField label={field.label} value={field.value} readOnly /> : null}
      {/* With a field above, its own bottom rhythm spaces the action (the login layout);
          without one, keep a small breath under the body line. */}
      <Box sx={{ mt: field ? 0 : 1 }}>
        <AuthButton type='button' href={actionHref}>
          {actionName}
        </AuthButton>
      </Box>
    </AuthLayout>
  );
}
