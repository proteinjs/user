/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * The user record form presents the two service-owned columns instead of hiding or faking them:
 *  - `roles` (an ArrayColumn, hidden by the default form — the founder opened the user form to
 *    change roles and found no roles at all) renders as chips of the held roles; a holder of the
 *    'roles' permission also gets a grant control fed by the roles catalog and a revoke on each
 *    chip. Both write through `RolesService` — the one audited write path — and then reload the
 *    record, so the chips show what is stored, not what was asked;
 *  - `status` renders read-only (its only writer is SetUserStatus) rather than as an editable box
 *    the form's save would silently drop.
 *
 * `UserAuth` reads from a static repo; stubbing it directly is how the invite customization test
 * and the server-side authz tests do it.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Column } from '@proteinjs/db';
import { RecordFormFieldProps } from '@proteinjs/db-ui';
import { RoleCatalogEntry, RolesCatalog, tables, User, UserAuth } from '@proteinjs/user';
import { UserRecordFormCustomization } from '../src/form/UserRecordFormCustomization';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The stored user row the (stubbed) Roles service writes and `reload` reads back. */
let stored: User;

const rolesService = {
  grantRole: jest.fn(async (userId: string, role: string) => {
    stored = { ...stored, roles: [...(stored.roles ?? []), role] };
  }),
  revokeRole: jest.fn(async (userId: string, role: string) => {
    stored = { ...stored, roles: (stored.roles ?? []).filter((held) => held !== role) };
  }),
};

jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getRolesService: () => rolesService,
}));

type UserAuthInternals = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  permissionRolesMapping?: { getRoles: (permission: string) => string[] | undefined };
};

const setCallerRoles = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'caller@n3xa.io', roles }),
  };
};

const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = {
    getRoles: (permission: string) => mapping[permission],
  };
};

const catalog: RoleCatalogEntry[] = [
  { role: 'admin', description: 'Break-glass superuser.', breakGlass: true },
  { role: 'ops', description: 'Runs the product: tickets, issues, cost.' },
  { role: 'dev', description: 'Engineering surfaces.' },
];

const userRecord = (overrides: Partial<User> = {}): User =>
  ({
    id: 'user-1',
    name: 'Ada',
    email: 'ada@n3xa.io',
    roles: ['ops'],
    status: 'active',
    ...overrides,
  }) as User;

describe('User record form customization', () => {
  let container: HTMLDivElement;
  let root: Root;
  const customization = new UserRecordFormCustomization();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(RolesCatalog, 'getEntries').mockReturnValue(catalog);
    setCallerRoles(['admin']);
    stored = userRecord();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
    jest.restoreAllMocks();
  });

  /**
   * Renders the field the way RecordForm's slot does: value from the record; reload re-reads the
   * stored row and re-renders. Reload runs inside the click's act scope, so it renders bare —
   * a nested act would overlap the outer one.
   */
  const renderField = async (fieldName: 'roles' | 'status') => {
    const Renderer = customization.getFieldRenderer(fieldName, stored);
    if (!Renderer) {
      throw new Error(`No renderer for ${fieldName}`);
    }

    const element = () => {
      const props: RecordFormFieldProps<User> = {
        table: tables.User,
        column: (tables.User.columns as any)[fieldName] as Column<User, any>,
        fieldName,
        label: fieldName === 'roles' ? 'Roles' : 'Status',
        record: stored,
        value: (stored as any)[fieldName],
        reload: async () => {
          root.render(element());
        },
      };
      return <Renderer {...props} />;
    };
    await act(async () => {
      root.render(element());
    });
  };

  const chips = () => Array.from(document.querySelectorAll('[data-role-chip]')).map((chip) => chip.textContent);
  const grantControl = () => document.querySelector('[data-grant-role]');
  const revokeButtons = () => Array.from(document.querySelectorAll('[data-role-chip] [data-testid="CancelIcon"]'));

  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  it('renders the held roles as chips', async () => {
    stored = userRecord({ roles: ['ops', 'dev'] });
    await renderField('roles');

    expect(chips()).toEqual(['ops', 'dev']);
  });

  it('offers the grant control and revoke only to a holder of the roles permission', async () => {
    await renderField('roles');
    expect(grantControl()).not.toBeNull();
    expect(revokeButtons()).toHaveLength(1);

    setCallerRoles([]);
    await renderField('roles');
    expect(chips()).toEqual(['ops']);
    expect(grantControl()).toBeNull();
    expect(revokeButtons()).toHaveLength(0);

    setCallerRoles(['support']);
    setMapping({ roles: ['support'] });
    await renderField('roles');
    expect(grantControl()).not.toBeNull();
  });

  it('grants through the Roles service and shows the stored roles afterwards', async () => {
    await renderField('roles');

    await click(grantControl()!);
    // The pick-list is the catalog minus what is already held — and never the break-glass role
    const options = Array.from(document.querySelectorAll('[role="menuitem"]'));
    expect(options.map((item) => item.querySelector('.MuiListItemText-primary')?.textContent)).toEqual(['dev']);
    expect(options[0].textContent).toContain('Engineering surfaces.');
    await click(options[0]);

    expect(rolesService.grantRole).toHaveBeenCalledWith('user-1', 'dev');
    expect(stored.roles).toEqual(['ops', 'dev']);
    expect(chips()).toEqual(['ops', 'dev']);
  });

  it('revokes through the Roles service from the chip', async () => {
    await renderField('roles');

    await click(revokeButtons()[0]);

    expect(rolesService.revokeRole).toHaveBeenCalledWith('user-1', 'ops');
    expect(stored.roles).toEqual([]);
    expect(chips()).toEqual([]);
  });

  it('shows a machine account read-only: its roles are declared in code', async () => {
    stored = userRecord({ isLoadedFromSource: true });
    await renderField('roles');

    expect(chips()).toEqual(['ops']);
    expect(grantControl()).toBeNull();
    expect(revokeButtons()).toHaveLength(0);
    expect(document.body.textContent).toContain('machine account');
  });

  it('renders status read-only (null reads as active), and leaves every other field to the form', async () => {
    await renderField('status');
    expect(document.body.textContent).toContain('Active');
    expect(document.querySelector('input')).toBeNull();

    stored = userRecord({ status: 'deactivated' });
    await renderField('status');
    expect(document.body.textContent).toContain('Deactivated');

    stored = userRecord({ status: null });
    await renderField('status');
    expect(document.body.textContent).toContain('Active');

    for (const fieldName of ['name', 'email', 'emailVerified', 'invitedBy']) {
      expect(customization.getFieldRenderer(fieldName, stored)).toBeUndefined();
    }
  });

  it('gives roles its own full-width row after the identity row', () => {
    const defaultLayout = [
      ['name', 'email'],
      ['password', 'emailVerified'],
      ['roles', 'invitedBy'],
      ['status', 'created'],
      ['updated'],
    ];
    expect(customization.getFieldLayout(userRecord(), defaultLayout)).toEqual([
      ['name', 'email'],
      ['roles'],
      ['password', 'emailVerified'],
      ['invitedBy', 'status'],
      ['created', 'updated'],
    ]);
    // The new-record form has no roles to show; its layout is untouched
    expect(customization.getFieldLayout(undefined, ['name', 'email'])).toEqual(['name', 'email']);
  });
});
