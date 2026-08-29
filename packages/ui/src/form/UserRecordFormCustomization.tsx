import { RecordFormCustomization, RecordFormFieldRenderer } from '@proteinjs/db-ui';
import { tables, User } from '@proteinjs/user';
import { UserRolesField } from './UserRolesField';
import { UserStatusField } from './UserStatusField';

/**
 * Makes the user record form tell the truth about its two service-owned columns:
 *  - `roles` is an ArrayColumn the default form hides; it renders as chips of the held roles with
 *    grant/revoke through `RolesService` (the one audited write path) for holders of the 'roles'
 *    permission — see `UserRolesField`;
 *  - `status` is written only by SetUserStatus; it renders read-only instead of as an editable box
 *    whose edits the form's save would silently drop — see `UserStatusField`.
 */
export class UserRecordFormCustomization extends RecordFormCustomization {
  public table = tables.User;

  getFieldRenderer(fieldName: string, user: User): RecordFormFieldRenderer<User> | undefined {
    if (fieldName === 'roles') {
      return UserRolesField;
    }

    if (fieldName === 'status') {
      return UserStatusField;
    }

    return undefined;
  }

  /**
   * Roles get their own full-width row right after the identity row: chips plus a grant control
   * need the width, and managing access is the main reason to open a user record. The rest of the
   * fields re-pair so no row is left with an orphan.
   */
  getFieldLayout(user: User | undefined, defaultFieldLayout: string[] | string[][]): string[] | string[][] {
    if (!user) {
      return defaultFieldLayout;
    }

    const rows = this.asRows(defaultFieldLayout);
    const rowWidth = Math.max(...rows.map((row) => row.length));
    const fields = ([] as string[]).concat(...rows).filter((field) => field !== 'roles');
    const identityRow = fields.splice(0, Math.min(rowWidth, fields.length));
    const layout: string[][] = [identityRow, ['roles']];
    for (let i = 0; i < fields.length; i += rowWidth) {
      layout.push(fields.slice(i, i + rowWidth));
    }

    return layout;
  }

  private asRows(layout: string[] | string[][]): string[][] {
    return layout.map((row) => (Array.isArray(row) ? row : [row]));
  }
}
