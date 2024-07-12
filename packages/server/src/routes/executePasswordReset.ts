import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/util';
import moment from 'moment';
import sha256 from 'crypto-js/sha256';

/**
 * Route handler for executing a password reset.
 *
 * This function handles the process of resetting a user's password using a provided reset token.
 * It verifies the token, checks its expiration, and updates the user's password if everything is valid.
 *
 * @bodyParam {string} token - The password reset token.
 * @bodyParam {string} newPassword - The new password for the user.
 *
 * @throws {Error} If there's an issue with the database operations or if the token is invalid or expired.
 */
export const executePasswordReset: Route = {
  path: routes.executePasswordReset.path,
  method: routes.executePasswordReset.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger('executePasswordReset');
    const { token, newPassword } = request.body;
    const db = getDbAsSystem();

    // Find user with the given reset token
    const user = await db.get(tables.User, { passwordResetToken: token });
    if (!user) {
      logger.info(`Invalid reset token used: ${token}`);
      response.status(400).send({ error: 'Invalid or expired reset token' });
      return;
    }

    // Check if token is expired
    const currentTime = moment();
    const tokenExpiration = moment(user.passwordResetTokenExpiration);
    if (currentTime.isAfter(tokenExpiration)) {
      logger.info(`Expired reset token used for user: ${user.email}`);
      response.status(400).send({ error: 'Reset token has expired' });
      return;
    }

    // Update user's password
    const hashedPassword = sha256(newPassword).toString();
    await db.update(tables.User, {
      id: user.id,
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetTokenExpiration: null,
    });

    logger.info(`Password successfully reset for user: ${user.email}`);
    response.send({ message: 'Password has been successfully reset' });
  },
};
