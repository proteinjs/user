import React from 'react';
import { Chip, FormHelperText, ListItemText, Menu, MenuItem, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { RecordFormFieldProps } from '@proteinjs/db-ui';
import { getRolesService, RoleCatalogEntry, RolesCatalog, User, UserAuth, USER_PERMISSIONS } from '@proteinjs/user';

/**
 * The `user.roles` slot on the user record form: chips of the held roles, and — for a holder of
 * the 'roles' permission — a grant control fed by the roles catalog plus a revoke on each chip.
 * Every change goes through `RolesService` (the one write path, audited per change) and then
 * reloads the record, so the chips show what is stored rather than what was asked.
 *
 * Read-only for everyone else, and for machine accounts regardless of permission: their roles
 * are declared in code and reverted to the declaration on every boot (the service refuses the
 * write too; the control just doesn't offer what can only fail). The break-glass role is never
 * in the pick-list — it is held by nobody day-to-day and is granted by bootstrap, not from here.
 */
export function UserRolesField({ record: user, value, label, reload }: RecordFormFieldProps<User, string[] | null>) {
  const heldRoles = value ?? [];
  const isMachineAccount = user.isLoadedFromSource === true;
  const canManage = UserAuth.hasPermission(USER_PERMISSIONS.roles) && !isMachineAccount;
  const grantable = RolesCatalog.getEntries().filter((entry) => !entry.breakGlass && !heldRoles.includes(entry.role));
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
  const [inFlight, setInFlight] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const change = async (write: () => Promise<void>) => {
    setMenuAnchor(null);
    setInFlight(true);
    setError(undefined);
    try {
      await write();
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInFlight(false);
    }
  };

  const grant = (entry: RoleCatalogEntry) => change(() => getRolesService().grantRole(user.id, entry.role));
  const revoke = (role: string) => change(() => getRolesService().revokeRole(user.id, role));

  return (
    <Stack spacing={0.5} data-user-roles>
      <Typography variant='caption' color='text.secondary'>
        {label}
      </Typography>
      <Stack direction='row' sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center', minHeight: 32 }}>
        {heldRoles.map((role) => (
          <Chip
            key={role}
            label={role}
            title={RolesCatalog.getEntry(role)?.description}
            data-role-chip
            disabled={inFlight}
            onDelete={canManage ? () => revoke(role) : undefined}
          />
        ))}
        {heldRoles.length === 0 && !canManage && (
          <Typography variant='body2' color='text.secondary'>
            None
          </Typography>
        )}
        {canManage && grantable.length > 0 && (
          <Chip
            label='Grant role'
            icon={<AddIcon />}
            variant='outlined'
            clickable
            data-grant-role
            disabled={inFlight}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          />
        )}
      </Stack>
      {/* Descriptions are sentences: a capped paper + wrapping items keep the list inside the viewport on a phone */}
      <Menu
        open={!!menuAnchor}
        anchorEl={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        PaperProps={{ sx: { maxWidth: 360 } }}
      >
        {grantable.map((entry) => (
          <MenuItem key={entry.role} onClick={() => grant(entry)} sx={{ whiteSpace: 'normal' }}>
            <ListItemText primary={entry.role} secondary={entry.description} />
          </MenuItem>
        ))}
      </Menu>
      {isMachineAccount && (
        <FormHelperText>Declared in code — a machine account's roles change with its declaration.</FormHelperText>
      )}
      {error && <FormHelperText error>{error}</FormHelperText>}
    </Stack>
  );
}
