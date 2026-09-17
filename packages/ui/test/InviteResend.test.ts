/**
 * The invite record form's Resend act: offered on an EXISTING invite row (beside Revoke) to a
 * caller with the 'users' permission — never on the new-record form, never to a caller who can't
 * perform it. Its outcome rides `SignupService.resendInvite` (the door's own refusal reads back
 * verbatim), and the form re-lands on the invite's own record so the fresh token and expiry show.
 *
 * Node environment like its sibling suite (InviteRecordFormCustomization.test.ts): the form's
 * db-ui import reaches uuid, whose browser build is ESM jest cannot parse under jsdom.
 */
import { FormButtons } from '@proteinjs/ui';
import { recordFormLink } from '@proteinjs/db-ui';
import { Invite, UserAuth } from '@proteinjs/user';
import { InviteRecordFormCustomization } from '../src/form/InviteRecordFormCustomization';

const signupService = {
  resendInvite: jest.fn(),
};
jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getSignupService: () => signupService,
}));

type UserAuthInternals = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
};

const setRoles = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'someone@example.com', roles }),
  };
};

const defaultFormButtons = (): FormButtons<any> => ({
  delete: { name: 'Delete', style: {} },
  save: { name: 'Save', style: {} },
  create: { name: 'Create', style: {} },
});

const existingInvite = { id: 'invite-1', email: 'invitee@example.com' } as Invite;

const buttons = (record: Invite | undefined) =>
  new InviteRecordFormCustomization().getFormButtons(record, defaultFormButtons());
const visible = (record: Invite | undefined) =>
  Object.keys(buttons(record)).filter((name) => !buttons(record)[name].accessibility?.hidden);

describe('Resend on the invite record form', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    signupService.resendInvite.mockReset();
  });

  it('is offered on an existing invite beside Revoke, and not on the new-record form', () => {
    setRoles(['admin']);
    expect(visible(existingInvite)).toEqual(expect.arrayContaining(['resend', 'revoke']));
    expect(visible(existingInvite)).not.toContain('send');
    expect(visible(undefined)).not.toContain('resend');
    expect(buttons(existingInvite).resend.name).toBe('Resend');
  });

  it('is never offered to a caller without the users permission', () => {
    setRoles([]);
    expect(visible(existingInvite)).not.toContain('resend');
  });

  it('re-sends through the service door and names the address on success', async () => {
    setRoles(['admin']);
    signupService.resendInvite.mockResolvedValue({ sent: true });
    const message = await buttons(existingInvite).resend.onClick!({} as any, {} as any);
    expect(signupService.resendInvite).toHaveBeenCalledWith('invitee@example.com');
    expect(message).toBe('Resent invite to invitee@example.com');
  });

  it("surfaces the door's own refusal verbatim", async () => {
    setRoles(['admin']);
    signupService.resendInvite.mockResolvedValue({ sent: false, error: 'No invite exists for that email.' });
    const message = await buttons(existingInvite).resend.onClick!({} as any, {} as any);
    expect(message).toBe('No invite exists for that email.');
  });

  it("re-lands on the invite's own record (the fresh token and expiry show on reload)", async () => {
    jest.useFakeTimers();
    try {
      setRoles(['admin']);
      const redirect = buttons(existingInvite).resend.redirect!({} as any, {} as any);
      jest.advanceTimersByTime(1400);
      await expect(redirect).resolves.toEqual({ path: recordFormLink('invite', 'invite-1') });
    } finally {
      jest.useRealTimers();
    }
  });
});
