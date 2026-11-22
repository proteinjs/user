import React, { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

export interface AuthLayoutProps {
  title: string;
  /** Optional supporting line rendered under the title: words, or words with a part of them set apart. */
  subtitle?: ReactNode;
  children?: ReactNode;
}

/**
 * Shared shell for the logged-out auth surfaces (login, signup, forgot/reset password).
 *
 * A single centered column that owns its own scrolling: on phones the on-screen keyboard
 * shrinks the app's dvh-sized page host, and the column scrolls instead of clipping the
 * fields. All colors come from the host app's MUI theme — this package stays generic and
 * the app's theme provider supplies the look.
 */
export function AuthLayout(props: AuthLayoutProps) {
  const { title, subtitle, children } = props;
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        backgroundColor: 'background.default',
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 400,
          px: 3,
          // Fixed share of the (dvh-sized) viewport: sits in the upper third at rest and
          // collapses gracefully when the phone keyboard shrinks the viewport.
          pt: 'clamp(48px, 16vh, 160px)',
          pb: 6,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* The title has line spacing of its own (30px for its 24px type), so one long enough to break
            on a narrow phone, or at a larger text size, reads as two even lines. The 6px the taller
            line adds above and below are taken back out of its margins: a one-line title and
            everything under it stand where they stood. */}
        <Typography
          component='h1'
          sx={{
            fontSize: '1.5rem',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: '30px',
            textWrap: 'balance',
            color: 'text.primary',
            mt: '-6px',
            mb: (theme) => `calc(${theme.spacing(subtitle ? 1 : 4)} - 6px)`,
          }}
        >
          {title}
        </Typography>
        {subtitle && (
          <Typography sx={{ fontSize: '0.875rem', lineHeight: 1.45, color: 'text.secondary', mb: 4 }}>
            {subtitle}
          </Typography>
        )}
        {children}
      </Box>
    </Box>
  );
}
