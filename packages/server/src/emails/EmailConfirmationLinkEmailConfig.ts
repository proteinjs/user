import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * The settings of the mail that carries the link confirming an account's email address: the one mail a
 * sign-up without an invite gets where a product asks for the confirmation (services/EmailConfirmation),
 * sent again when a waiting account is started over and at a re-send. It only confirms; the welcome goes
 * when the address is confirmed.
 *
 * The interface lives here because @proteinjs/email-server is a registry package (the
 * AccountDeletionEmailConfigs pattern). The default below is plain; a product registers a factory to
 * word the mail as its own.
 */
export interface EmailConfirmationLinkEmailConfig {
  subject: string;
  /**
   * @param confirmEmailLink the partial path the mail's link opens: the confirmation's page with its
   * token, in the format 'account/verify-email?token=abc123def456'. NOT a full URL: prepend the
   * product's own address to make a link a person can open.
   */
  getEmailContent: (confirmEmailLink: string) => {
    text: string;
    html?: string;
  };
}

export interface DefaultEmailConfirmationLinkEmailConfigFactory extends Loadable {
  getConfig(): EmailConfirmationLinkEmailConfig;
}

export const getDefaultEmailConfirmationLinkEmailConfigFactory = (): DefaultEmailConfirmationLinkEmailConfigFactory => {
  const defaultFactory: DefaultEmailConfirmationLinkEmailConfigFactory = {
    getConfig: () => ({
      subject: 'Confirm your email',
      getEmailContent: (confirmEmailLink: string) => ({
        text: `Open this link to confirm your email address: ${confirmEmailLink}`,
      }),
    }),
  };

  const retrievedFactory = SourceRepository.get().object<DefaultEmailConfirmationLinkEmailConfigFactory>(
    '@proteinjs/user-server/DefaultEmailConfirmationLinkEmailConfigFactory'
  );

  return retrievedFactory || defaultFactory;
};
