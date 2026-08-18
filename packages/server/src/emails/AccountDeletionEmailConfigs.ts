import { Loadable, SourceRepository } from '@proteinjs/reflection';
import Mail from 'nodemailer/lib/mailer';
import { Moment } from 'moment';

/**
 * Config-factory seams for the two account-deletion emails (the PasswordResetEmailConfig
 * pattern; the interfaces live here because @proteinjs/email-server is a registry package).
 * Both emails are self-contained notifications, so each getter carries default content (the
 * PasswordUpdatedEmailConfig precedent) — an app implements the factory to override.
 */

export interface AccountDeletionRequestedEmailConfig {
  /** @see https://nodemailer.com/message/ for all available options */
  options?: Mail.Options;
  /** @param purgeAfter when the grace window ends and the account is permanently erased */
  getEmailContent: (purgeAfter: Moment) => {
    text: string;
    html?: string;
  };
}

export interface DefaultAccountDeletionRequestedEmailConfigFactory extends Loadable {
  getConfig(): AccountDeletionRequestedEmailConfig;
}

export const getDefaultAccountDeletionRequestedEmailConfigFactory =
  (): DefaultAccountDeletionRequestedEmailConfigFactory => {
    const defaultFactory: DefaultAccountDeletionRequestedEmailConfigFactory = {
      getConfig: () => ({
        options: { subject: 'Your account is scheduled for deletion' },
        getEmailContent: (purgeAfter: Moment) => ({
          text:
            `Your account is scheduled for deletion. Your content is no longer visible to you or to ` +
            `anyone you shared it with. You can change your mind until ${purgeAfter.format('MMMM D, YYYY')} ` +
            `by simply logging back in — that restores everything, including shares. After that date, your ` +
            `account and everything in it are permanently removed from our systems, and we'll email you to ` +
            `confirm when it's done. If you didn't request this, log back in now to cancel.`,
        }),
      }),
    };

    const retrievedFactory = SourceRepository.get().object<DefaultAccountDeletionRequestedEmailConfigFactory>(
      '@proteinjs/user-server/DefaultAccountDeletionRequestedEmailConfigFactory'
    );

    return retrievedFactory || defaultFactory;
  };

export interface AccountDeletedEmailConfig {
  /** @see https://nodemailer.com/message/ for all available options */
  options?: Mail.Options;
  getEmailContent: () => {
    text: string;
    html?: string;
  };
}

export interface DefaultAccountDeletedEmailConfigFactory extends Loadable {
  getConfig(): AccountDeletedEmailConfig;
}

export const getDefaultAccountDeletedEmailConfigFactory = (): DefaultAccountDeletedEmailConfigFactory => {
  const defaultFactory: DefaultAccountDeletedEmailConfigFactory = {
    getConfig: () => ({
      options: { subject: 'Your account has been deleted' },
      getEmailContent: () => ({
        text:
          `Your account and everything in it have been permanently removed from our systems. ` +
          `This is the confirmation you were promised when you requested deletion. Goodbye, and thank you.`,
      }),
    }),
  };

  const retrievedFactory = SourceRepository.get().object<DefaultAccountDeletedEmailConfigFactory>(
    '@proteinjs/user-server/DefaultAccountDeletedEmailConfigFactory'
  );

  return retrievedFactory || defaultFactory;
};
