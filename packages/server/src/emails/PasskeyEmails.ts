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
 * The mail tells of a change that has ALREADY committed, and the act's answer does not wait for
 * it: `UserPasskeys` starts the telling once its transaction has committed and does not await it,
 * so a mail transport that cannot be reached holds no sign-in, removal or reset open for as long
 * as its connection takes to give up. Nothing awaits a telling, so nothing would catch it: `tell`
 * never rejects. A failure to send — no transport, a refused message, an account gone since — is
 * one error line naming the account by digest: a passkey's removal is not undone, and a sign-in
 * is not refused, because the notice about it could not be handed over.
 *
 * The mail goes to the account's address and to nobody else: a config's options carry the app's
 * frame, never a recipient — whatever `to`, `cc` and `bcc` they name is dropped.
 */
export class PasskeyEmails {
  private readonly logger = new Logger({ name: 'PasskeyEmails' });

  /**
   * Tell the account `userId` of `change`, at the address its row holds now. Resolves when the
   * send has ended, however it ended; never rejects.
   */
  async tell(userId: string, change: PasskeyChange): Promise<void> {
    let account: string | undefined;
    try {
      const user = await getDbAsSystem().get(tables.User, { id: userId });
      if (!user) {
        this.logger.error({ message: 'Passkey mail not sent: the account is gone', obj: { user: userId, change } });
        return;
      }

      account = new RequestDigests().account(user.email);
      const config = getDefaultPasskeyChangedEmailConfigFactory().getConfig();
      const { subject, text, html } = config.getEmailContent(change);
      await new EmailSender().sendEmail({
        ...config.options,
        to: user.email,
        cc: undefined,
        bcc: undefined,
        subject,
        text,
        html,
      });
    } catch (error: unknown) {
      this.failed(userId, account, change, error);
    }
  }

  /**
   * The one error line of a mail that was not sent. It cannot throw either: where the line itself
   * cannot be written as it must be (a process that cannot digest redacts nothing), a bare line
   * says so without the error, whose words may name an address.
   */
  private failed(userId: string, account: string | undefined, change: PasskeyChange, error: unknown): void {
    try {
      this.logger.error({
        message: 'Passkey mail failed to send',
        obj: { user: userId, account, change },
        error: new RequestDigests().redactError(error),
      });
    } catch {
      console.error('Passkey mail failed to send, and its error line could not be written');
    }
  }
}
