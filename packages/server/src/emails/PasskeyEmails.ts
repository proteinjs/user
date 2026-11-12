import { getDbAsSystem } from '@proteinjs/db';
import { EmailSender } from '@proteinjs/email-server';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { tables } from '@proteinjs/user';
import { PasskeyChange, getDefaultPasskeyChangedEmailConfigFactory } from './PasskeyChangedEmailConfig';

/**
 * Thin sender for the one mail an account is sent when its passkeys change — one added, one
 * removed, all reset by an admin. It is how an account's owner learns of a passkey they did not
 * add (a first passkey is enrolled on the password alone) and of a reset they did not ask for.
 * Content comes from the config factory beside this class; transport is the app's
 * DefaultEmailConfigFactory SMTP config via EmailSender.
 *
 * The mail tells of a change that has ALREADY committed (`UserPasskeys` sends it after its
 * transaction), so a failure to send — no transport, a refused message, an account gone since —
 * is one error line naming the account by digest, never a throw: a passkey's removal is not
 * undone, and a sign-in is not refused, because the notice about it could not be handed over.
 */
export class PasskeyEmails {
  private readonly logger = new Logger({ name: 'PasskeyEmails' });

  /** Tell the account `userId` of `change`, at the address its row holds now. Never throws. */
  async tell(userId: string, change: PasskeyChange): Promise<void> {
    const digests = new RequestDigests();
    let account: string | undefined;
    try {
      const user = await getDbAsSystem().get(tables.User, { id: userId });
      if (!user) {
        this.logger.error({ message: 'Passkey mail not sent: the account is gone', obj: { user: userId, change } });
        return;
      }

      account = digests.account(user.email);
      const config = getDefaultPasskeyChangedEmailConfigFactory().getConfig();
      const { subject, text, html } = config.getEmailContent(change);
      await new EmailSender().sendEmail({ ...config.options, to: user.email, subject, text, html });
    } catch (error: unknown) {
      this.logger.error({
        message: 'Passkey mail failed to send',
        obj: { user: userId, account, change },
        error: digests.redactError(error),
      });
    }
  }
}
