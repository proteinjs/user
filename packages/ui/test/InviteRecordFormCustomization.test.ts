import { FormButtons } from '@proteinjs/ui';
import { Invite, UserAuth } from '@proteinjs/user';
import { InviteRecordFormCustomization } from '../src/form/InviteRecordFormCustomization';

/**
 * Invites are managed from the invite record surface: the new-record form sends one, an existing
 * invite row revokes one. Both actions are admin-only — `SignupService.serviceMetadata.auth` is the
 * enforcement (covered in @proteinjs/user-server), and these assertions cover the affordances, so a
 * non-admin is never offered a button that can only fail.
 *
 * `UserAuth` reads from a static repo; stubbing it directly is how the server-side authz tests do it.
 */

type UserAuthInternals = { userRepo?: { getUser: () => { email: string; roles: string[] } } };

const setRoles = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'someone@n3xa.io', roles }),
  };
};

const defaultFormButtons = (): FormButtons<any> => ({
  delete: { name: 'Delete', style: {} },
  save: { name: 'Save', style: {} },
  create: { name: 'Create', style: {} },
});

const defaultFieldLayout = ['email', 'token', 'tokenExpiresAt', 'invitedBy'];
const existingInvite = { id: 'invite-1', email: 'invitee@n3xa.io' } as Invite;

const visibleButtons = (record: Invite | undefined) => {
  const buttons = new InviteRecordFormCustomization().getFormButtons(record, defaultFormButtons());
  return Object.keys(buttons).filter((name) => !buttons[name].accessibility?.hidden);
};

describe('Invite record form customization', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  it('replaces raw record create/delete with send/revoke', () => {
    setRoles(['admin']);
    const buttons = new InviteRecordFormCustomization().getFormButtons(existingInvite, defaultFormButtons());
    expect(Object.keys(buttons)).not.toContain('create');
    expect(Object.keys(buttons)).not.toContain('delete');
  });

  it('offers an admin Send invite on the new-record form and Revoke on an existing invite', () => {
    setRoles(['admin']);
    expect(visibleButtons(undefined)).toContain('send');
    expect(visibleButtons(undefined)).not.toContain('revoke');
    expect(visibleButtons(existingInvite)).toContain('revoke');
    expect(visibleButtons(existingInvite)).not.toContain('send');
  });

  it('offers a non-admin neither action', () => {
    setRoles([]);
    expect(visibleButtons(undefined)).not.toContain('send');
    expect(visibleButtons(undefined)).not.toContain('revoke');
    expect(visibleButtons(existingInvite)).not.toContain('send');
    expect(visibleButtons(existingInvite)).not.toContain('revoke');
  });

  it('asks only for an email when sending, and shows the whole record otherwise', () => {
    const customization = new InviteRecordFormCustomization();
    expect(customization.getFieldLayout(undefined, defaultFieldLayout)).toEqual(['email']);
    expect(customization.getFieldLayout(existingInvite, defaultFieldLayout)).toEqual(defaultFieldLayout);
  });
});
