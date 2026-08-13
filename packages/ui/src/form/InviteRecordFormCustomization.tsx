import { Fields, FormButton, FormButtons } from '@proteinjs/ui';
import { RecordFormCustomization, recordTableLink } from '@proteinjs/db-ui';
import { getSignupService, Invite, tables, UserAuth, USER_PERMISSIONS } from '@proteinjs/user';
import { emailRegex } from '@proteinjs/util';

/**
 * Makes the invite record surface the ONE place invites are managed: the new-record form sends an
 * invite, and an existing invite row can be revoked.
 *
 * Both actions go through `SignupService` rather than raw record writes, because an invite is more
 * than its row — sending mints a token, sets its expiry, stamps the inviter, and emails the signup
 * link; revoking is the invite domain's own delete. Inserting or deleting the row directly would
 * produce invites that can never be redeemed.
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
    formButtons['send'] = this.sendButton(invite);
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
