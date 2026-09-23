import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables, uiRoutes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import moment from 'moment';
import {
  EmailSender,
  getDefaultPasswordResetEmailConfigFactory as getDefaultConfigFactory,
} from '@proteinjs/email-server';
import { PasswordResetToken } from '../authentication/PasswordResetToken';
import { ClientAddress } from '../throttle/ClientAddress';
import { RequestDigests } from '../throttle/RequestDigests';
import { passwordResetThrottle } from '../throttle/PasswordResetThrottle';

/**
 * The door's one answer: the same words for an address with an account or without, inside or
 * past a window, mailed or not — the page shows exactly this sentence.
 */
const ONE_ANSWER = { message: 'If that address has an account, a reset link is on its way.' };

/**
 * Route for initiating a password reset process.
 *
 * Mints a reset token through `PasswordResetToken` — which stores only the token's digest and
 * its expiry on the user row — and mails the token to the account as a reset link. The token is
 * withdrawn again when the mail fails to send.
 *
 * ONE ANSWER: every request with an address is answered `ONE_ANSWER` — BEFORE the address is
 * looked up — whether it has an account, is throttled (`PasswordResetThrottle`: per client and
 * per address), is inside the account's five-minute gap, or its mail fails; so neither the
 * words, the status nor the timing say whether an address has an account. The work runs after
 * the answer. Every request is one outcome line carrying the account digest and the coarse IP
 * hash (`RequestDigests`) — never the address.
 *
 * Requires an implementation of `DefaultPasswordResetEmailConfigFactory` to build the password reset email with.
 *
 * @bodyParam {string} email - The email address of the user requesting a password reset.
 * This will be combined with the generated token to create the reset link that is emailed to the user.
 *
 * @throws {Error} If there's an issue with sending the email or updating the database.
 */
export const initiatePasswordReset: Route = {
  path: routes.initiatePasswordReset.path,
  method: routes.initiatePasswordReset.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger({ name: 'initiatePasswordReset' });
    const { email: requestedEmail } = request.body ?? {};
    if (typeof requestedEmail !== 'string' || requestedEmail.length === 0) {
      response.status(400).send({ error: 'Email cannot be blank' });
      return;
    }

    const digests = new RequestDigests();
    const fields = { account: digests.account(requestedEmail), ip: digests.coarseIp(new ClientAddress().of(request)) };
    const window = passwordResetThrottle.admit(fields.ip, fields.account);
    response.send(ONE_ANSWER);
    if (window) {
      logger.warn({ message: `Password reset throttled`, obj: { ...fields, window } });
      return;
    }

    const email = requestedEmail.toLowerCase();
    const db = getDbAsSystem();
    const user = await db.get(tables.User, { email });
    if (!user) {
      logger.info({ message: `Password reset requested for non-existent user`, obj: fields });
      return;
    }

    // Check if there's an existing token and it's less than 5 minutes old
    const resetToken = new PasswordResetToken();
    const mintedAt = resetToken.mintedAt(user);
    if (mintedAt && moment().diff(mintedAt, 'minutes') < 5) {
      logger.info({ message: `Password reset requested too soon for user`, obj: fields });
      return;
    }

    const emailSender = new EmailSender();

    const defaultConfigFactory = getDefaultConfigFactory();
    if (!defaultConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/email-server/DefaultPasswordResetEmailConfigFactory implementation when initiating password reset.`
      );
    }

    // The row now holds the token's digest; the token itself goes only into the mailed link
    const passwordResetToken = await resetToken.mint(user);

    try {
      const config = defaultConfigFactory.getConfig();
      const { text, html } = config.getEmailContent(`${uiRoutes.auth.passwordReset}?token=${passwordResetToken}`);

      // Send email containing a reset link
      await emailSender.sendEmail({
        to: user.email,
        subject: config.options?.subject || 'Reset Password',
        text,
        html,
        ...config.options,
      });

      logger.info({ message: `Password reset link mailed`, obj: fields });
    } catch (error: any) {
      logger.error({ message: `Failed to send password reset email`, obj: fields, error });
      // The link never reached the account: withdraw the token so asking again is not throttled
      await resetToken.revoke(user, passwordResetToken);
    }
  },
};
