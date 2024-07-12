import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { generateSecureToken, Logger } from '@proteinjs/util';
import moment from 'moment';
import {
  EmailSender,
  getDefaultPasswordResetEmailConfigFactory as getDefaultConfigFactory,
} from '@proteinjs/email-server';

/**
 * Route for initiating a password reset process.
 *
 * This route handles the process of generating a password reset token,
 * sending a reset email to the user, and storing the token and expiration of the token in the database.
 *
 * @bodyParam {string} email - The email address of the user requesting a password reset.
 * @bodyParam {string} resetPath - The path to the password reset page in the client application.
 * This will be combined with the generated token to create the reset link that is emailed to the user.
 *
 * @returns {object} A generic response to avoid revealing whether an account exists.
 *
 * @throws {Error} If there's an issue with sending the email or updating the database.
 */
export const initiatePasswordReset: Route = {
  path: routes.initiatePasswordReset.path,
  method: routes.initiatePasswordReset.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger('initiatePasswordReset');
    const { email, resetPath } = request.body;
    const db = getDbAsSystem();

    const genericResponse = { message: 'If an account with that email exists, we have sent a password reset link.' };

    // Check if user exists
    const user = await db.get(tables.User, { email });
    if (!user) {
      logger.info(`Password reset requested for non-existent user: ${email}`);
      // Don't reveal that the user doesn't exist
      response.send(genericResponse);
      return;
    }

    // Check if there's an existing token and it's less than 5 minutes old
    const currentTime = moment();
    if (user.passwordResetToken && user.passwordResetTokenExpiration) {
      const tokenAge = currentTime.diff(moment(user.passwordResetTokenExpiration), 'minutes');
      if (tokenAge < -55) {
        // Token is less than 5 minutes old
        logger.info(`Password reset requested too soon for user: ${email}`);
        response.send(genericResponse);
        return;
      }
    }

    const emailSender = new EmailSender();

    const defaultConfigFactory = getDefaultConfigFactory();
    if (!defaultConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/email-server/DefaultPasswordResetEmailConfigFactory implementation when initiating password reset.`
      );
    }

    // Generate reset token
    const passwordResetToken = generateSecureToken();
    const passwordResetTokenExpiration = moment().add(1, 'hour');

    try {
      const config = defaultConfigFactory.getConfig();
      const { text, html } = config.getEmailContent(`${resetPath}?token=${passwordResetToken}`);

      // Send email containing a reset link
      await emailSender.sendEmail({
        to: user.email,
        subject: config.options?.subject || 'Reset Password',
        text,
        html,
      });

      // If email is sent successfully, save reset token to user record
      await db.update(tables.User, { id: user.id, passwordResetToken, passwordResetTokenExpiration });
      logger.info(`Password reset email sent to: ${email}`);
      response.send(genericResponse);
    } catch (error: any) {
      logger.error(`Failed to send password reset email to: ${email}`, error);
      response.status(500).send({ error: 'Failed to send password reset email. Please try again later.' });
    }
  },
};
