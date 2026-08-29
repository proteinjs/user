import React from 'react';
import { Chip, Stack, Typography } from '@mui/material';
import { RecordFormFieldProps } from '@proteinjs/db-ui';
import { User, UserStatus } from '@proteinjs/user';

/**
 * The `user.status` slot on the user record form: the account's standing, read-only. Its only
 * writer is the SetUserStatus service (audited per change); an editable box here would take edits
 * the form's save silently drops. A null status (rows predating the column) reads as active —
 * the same reading every gate applies.
 */
export function UserStatusField({ value, label }: RecordFormFieldProps<User, UserStatus | null | undefined>) {
  const status: UserStatus = value ?? 'active';

  return (
    <Stack spacing={0.5} data-user-status>
      <Typography variant='caption' color='text.secondary'>
        {label}
      </Typography>
      <Stack direction='row' sx={{ alignItems: 'center', minHeight: 32 }}>
        <Chip
          label={status === 'deactivated' ? 'Deactivated' : 'Active'}
          variant='outlined'
          color={status === 'deactivated' ? 'default' : 'success'}
          size='small'
        />
      </Stack>
    </Stack>
  );
}
