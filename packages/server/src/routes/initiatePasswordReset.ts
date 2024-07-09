import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/util';
import { v1 as uuidv1 } from 'uuid';
import { EmailSender } from '../email/EmailSender';
import moment from 'moment';

export const initiatePasswordReset: Route = {
  path: routes.initiatePasswordReset.path,
  method: routes.initiatePasswordReset.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger('initiatePasswordReset');
    const { email } = request.body;
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

    // Generate reset token
    const passwordResetToken = uuidv1();
    const passwordResetTokenExpiration = moment().add(1, 'hour');

    // Save reset token to user record
    await db.update(tables.User, { id: user.id, passwordResetToken, passwordResetTokenExpiration });

    const emailSender = new EmailSender();

    // Send email with reset link
    const resetUrl = `https://n3xa.io/resetPassword?token=${passwordResetToken}`;
    await emailSender.sendEmail({
      to: user.email,
      subject: 'Password Reset',
      text: `You are receiving this because you (or someone else) have requested the reset of the password for your account.\n\n
        Please click on the following link, or paste this into your browser to complete the process:\n\n
        ${resetUrl}\n\n
        If you did not request this, please ignore this email and your password will remain unchanged.\n`,
    });

    logger.info(`Password reset email sent to: ${email}`);
    response.send(genericResponse);
  },
};
