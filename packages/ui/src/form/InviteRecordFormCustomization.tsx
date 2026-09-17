import { Fields, FormButton, FormButtons } from '@proteinjs/ui';
import { RecordFormCustomization, recordFormLink, recordTableLink } from '@proteinjs/db-ui';
import { getSignupService, Invite, tables, UserAuth, USER_PERMISSIONS } from '@proteinjs/user';
import { emailRegex } from '@proteinjs/util';

/**
 * Makes the invite record surface the ONE place invites are managed: the new-record form sends an
 * invite, and an existing invite row can be re-sent or revoked.
 *
 * All three actions go through `SignupService` rather than raw record writes, because an invite is
 * more than its row — sending mints a token, sets its expiry, stamps the inviter, and emails the
 * signup link; re-sending retires the earlier token, mints a fresh one and emails it again; revoking
 * is the invite domain's own delete. Inserting or deleting the row directly would produce invites
 * that can never be redeemed.
 */
export class InviteRecordFormCustomization extends RecordFormCustomization {
  public table = tables.Invite;

  getFieldLayout(invite: Invite | undefined, defaultFieldLayout: string[] | string[][]): string[] | string[][] {
    // Sending an invite takes only an email; the token, its expiry, and the inviter are minted server-side.
    return invite ? defaultFieldLayout : ['email'];
  }

  getFormButtons(invite: Invite | undefined, defaultFormButtons: FormButtons<any>): FormButtons<any> {
    const formButtons = { ...defaultFormButtons };
    delete formButtons['create'];
    delete formButtons['delete'];
    // No generic Save either: the invite table's db doors close generic writes (query/delete only —
    // a raw update would be refused at the door), so Save could only ever fail; the row's acts are
    // Resend and Revoke.
    delete formButtons['save'];
    formButtons['send'] = this.sendButton(invite);
    formButtons['resend'] = this.resendButton(invite);
    formButtons['revoke'] = this.revokeButton(invite);
    return formButtons;
  }

  private sendButton(invite: Invite | undefined): FormButton<any> {
    return {
      name: 'Send invite',
      accessibility: {
        hidden: !!invite || !this.canManageUsers(),
      },
      style: {
        color: 'primary',
        variant: 'contained',
      },
      onClick: async (fields: Fields) => {
        const email = fields.email.field.value && fields.email.field.value.trim();
        if (!email) {
          return 'Please enter an email address.';
        }

        if (!emailRegex.test(email)) {
          return 'Please enter a valid email address.';
        }

        const response = await getSignupService().sendInvite(email);
        if (response.sent === false) {
          return response.error || 'Failed to send invite.';
        }

        return `Sent invite to ${email}`;
      },
      progressMessage: () => `Sending invite`,
    };
  }

  /**
   * Re-sends a standing invite through `SignupService.resendInvite`: the earlier link stops working
   * and a fresh one is emailed. The row stays, so the form re-lands on itself — after a beat, because
   * the generic form paints its message and navigates in the same tick, and the navigation remounts
   * the page (a re-land without the beat would eat the confirmation); the reload then shows the
   * row's fresh token and expiry.
   */
  private resendButton(invite: Invite | undefined): FormButton<any> {
    return {
      name: 'Resend',
      accessibility: {
        hidden: !invite || !this.canManageUsers(),
      },
      style: {
        color: 'primary',
        variant: 'contained',
      },
      redirect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1400));
        return { path: recordFormLink(tables.Invite.name, (invite as Invite).id) };
      },
      onClick: async () => {
        const response = await getSignupService().resendInvite((invite as Invite).email);
        if (response.sent === false) {
          return response.error || 'Failed to resend invite.';
        }

        return `Resent invite to ${(invite as Invite).email}`;
      },
      progressMessage: () => `Resending invite`,
    };
  }

  private revokeButton(invite: Invite | undefined): FormButton<any> {
    return {
      name: 'Revoke',
      accessibility: {
        hidden: !invite || !this.canManageUsers(),
      },
      style: {
        color: 'primary',
        variant: 'text',
      },
      // The row is gone once revoked, so return to the table rather than leave a form over nothing.
      redirect: async () => {
        return { path: recordTableLink(tables.Invite) };
      },
      onClick: async () => {
        await getSignupService().revokeInvite((invite as Invite).email);
        return `Revoked invite to ${(invite as Invite).email}`;
      },
      progressMessage: () => `Revoking invite`,
    };
  }

  /**
   * The same 'users'-permission gate the service door carries, so these actions aren't offered to
   * users who can't perform them. `SignupService.serviceMetadata.auth` is what actually enforces
   * it; admin still passes via break-glass.
   */
  private canManageUsers(): boolean {
    return UserAuth.hasPermission(USER_PERMISSIONS.users);
  }
}
