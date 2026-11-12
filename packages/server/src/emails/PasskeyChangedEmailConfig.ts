import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { EmailSender } from '@proteinjs/email-server';

/**
 * Config-factory seam for the mail an account is sent when its passkeys change (the
 * AccountDeletionEmailConfigs pattern; the interface lives here because @proteinjs/email-server is
 * a registry package). The mail is a self-contained notice, so the getter carries default content
 * (the PasswordUpdatedEmailConfig precedent) — an app implements the factory to say it in its own
 * words and frame.
 */

/** What happened to the account's passkeys: one was added, one was removed, or an admin reset them all. */
export type PasskeyChange = 'added' | 'removed' | 'reset';

/**
 * The message options a config may set — exactly what `EmailSender.sendEmail` accepts, named
 * through that door so the public declarations lean on @proteinjs/email-server (a dependency)
 * and never on the transport library's own types (a devDependency a registry copy never has).
 * The recipient and the content are never the options' to set: the mail goes to the account's
 * address, with the content below.
 * @see https://nodemailer.com/message/ for the options the sender's transport takes today
 */
export type PasskeyChangedEmailOptions = Parameters<EmailSender['sendEmail']>[0];

export interface PasskeyChangedEmailConfig {
  options?: PasskeyChangedEmailOptions;
  /** @param change what happened to the account's passkeys */
  getEmailContent: (change: PasskeyChange) => {
    subject: string;
    text: string;
    html?: string;
  };
}

export interface DefaultPasskeyChangedEmailConfigFactory extends Loadable {
  getConfig(): PasskeyChangedEmailConfig;
}

export const getDefaultPasskeyChangedEmailConfigFactory = (): DefaultPasskeyChangedEmailConfigFactory => {
  const notYou = `If this wasn't you, reset your password right away.`;
  const content: Record<PasskeyChange, { subject: string; text: string }> = {
    added: {
      subject: 'A passkey was added to your account',
      text: `A passkey was just added to your account. If this was you, there's nothing else to do. ${notYou}`,
    },
    removed: {
      subject: 'A passkey was removed from your account',
      text:
        `A passkey was just removed from your account, and your other devices were signed out. ` +
        `If this was you, there's nothing else to do. ${notYou}`,
    },
    reset: {
      subject: 'Your passkeys were reset',
      text:
        `An admin reset the passkeys on your account, and you were signed out everywhere. The next time you ` +
        `sign in, you'll add a new passkey. If you didn't ask for this, reply to this email.`,
    },
  };
  const defaultFactory: DefaultPasskeyChangedEmailConfigFactory = {
    getConfig: () => ({ getEmailContent: (change: PasskeyChange) => content[change] }),
  };

  const retrievedFactory = SourceRepository.get().object<DefaultPasskeyChangedEmailConfigFactory>(
    '@proteinjs/user-server/DefaultPasskeyChangedEmailConfigFactory'
  );

  return retrievedFactory || defaultFactory;
};
