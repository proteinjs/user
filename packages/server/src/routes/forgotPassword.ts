import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/util';
import { v1 as uuidv1 } from 'uuid';
import { EmailSender } from '../email/EmailSender';
import moment from 'moment';

export const forgotPassword: Route = {
  path: routes.forgotPassword.path,
  method: routes.forgotPassword.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger('forgotPassword');
    const { email } = request.body;
    const db = getDbAsSystem();

    // Check if user exists
    const user = await db.get(tables.User, { email });
    if (!user) {
      logger.info(`Password reset requested for non-existent user: ${email}`);
      // Don't reveal that the user doesn't exist
      response.send({ message: 'If an account with that email exists, we have sent a password reset link.' });
      return;
    }

    // Generate reset token
    const passwordResetToken = uuidv1();
    const passwordResetTokenExpiration = moment().add(1, 'hour');

    // Save reset token to user record
    await db.update(tables.User, { id: user.id }, { passwordResetToken, passwordResetTokenExpiration });

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
    response.send({ message: 'If an account with that email exists, we have sent a password reset link.' });
  },
};
