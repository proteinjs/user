import React, { useState } from 'react';
import { Box, IconButton, InputAdornment, TextField, Typography } from '@mui/material';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';

export interface AuthTextFieldProps {
  label: string;
  value: string;
  /** Omitted for read-only fields. */
  onChange?: (value: string) => void;
  /** Renders a reveal toggle and masks input until toggled. */
  password?: boolean;
  /**
   * Renders the value as fixed (e.g. the invite's email on signup). Read-only rather than
   * disabled on purpose: password managers ignore disabled inputs but do read read-only ones —
   * which matters when the field is the credential's username.
   */
  readOnly?: boolean;
  /** HTML autocomplete token (e.g. 'username', 'current-password', 'new-password'). */
  autoComplete?: string;
  /** HTML input type when not a password field (e.g. 'email'). */
  type?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

/**
 * Auth-surface text input: a small label above a rounded field (the label-above pattern —
 * no floating-label notch fighting the corner radius). 48px tall for a comfortable touch
 * target; 1rem input text so mobile browsers don't auto-zoom the field on focus.
 */
export function AuthTextField(props: AuthTextFieldProps) {
  const { label, value, onChange, password, readOnly, autoComplete, type, autoFocus, disabled } = props;
  const [revealed, setRevealed] = useState(false);

  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography
        component='label'
        htmlFor={`auth-field-${label}`}
        sx={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'text.primary', mb: 0.75 }}
      >
        {label}
      </Typography>
      <TextField
        id={`auth-field-${label}`}
        fullWidth
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        type={password && !revealed ? 'password' : password ? 'text' : type || 'text'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        InputProps={{
          readOnly,
          endAdornment: password ? (
            <InputAdornment position='end'>
              <IconButton
                aria-label={revealed ? 'Hide password' : 'Show password'}
                onClick={() => setRevealed(!revealed)}
                edge='end'
                sx={{ color: 'text.secondary', p: '12px' }}
              >
                {revealed ? <VisibilityOff sx={{ fontSize: 20 }} /> : <Visibility sx={{ fontSize: 20 }} />}
              </IconButton>
            </InputAdornment>
          ) : undefined,
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            borderRadius: '12px',
            // A read-only field wears a subtle fill and keeps a quiet border, so it reads as a
            // fixed value rather than an input that ignores typing.
            backgroundColor: readOnly ? 'action.hover' : 'background.paper',
            fontSize: '1rem',
            '& input': { py: '12.5px', px: '14px' },
            '& fieldset': { borderColor: 'divider' },
            '&:hover fieldset': { borderColor: readOnly ? 'divider' : 'text.disabled' },
            '&.Mui-focused fieldset': { borderColor: 'primary.main', borderWidth: '1.5px' },
          },
        }}
      />
    </Box>
  );
}
