import { Moment } from 'moment';
import { EmailSender } from '@proteinjs/email-server';
import {
  getDefaultAccountDeletedEmailConfigFactory,
  getDefaultAccountDeletionRequestedEmailConfigFactory,
} from './AccountDeletionEmailConfigs';

/**
 * Thin sender for the two account-deletion emails: deletion-requested (at deactivation — the
 * only cancel channel an account-takeover victim has) and the store-required completion
 * confirmation (sent by the purge walker after the user row is gone). Content comes from the
 * config factories beside this class; transport is the app's DefaultEmailConfigFactory SMTP
 * config via EmailSender.
 */
export class AccountDeletionEmails {
  async sendDeletionRequested(to: string, purgeAfter: Moment): Promise<void> {
    const config = getDefaultAccountDeletionRequestedEmailConfigFactory().getConfig();
    const { text, html } = config.getEmailContent(purgeAfter);
    await new EmailSender().sendEmail({
      to,
      subject: 'Your account is scheduled for deletion',
      text,
      html,
      ...config.options,
    });
  }

  async sendAccountDeleted(to: string): Promise<void> {
    const config = getDefaultAccountDeletedEmailConfigFactory().getConfig();
    const { text, html } = config.getEmailContent();
    await new EmailSender().sendEmail({
      to,
      subject: 'Your account has been deleted',
      text,
      html,
      ...config.options,
    });
  }
}
