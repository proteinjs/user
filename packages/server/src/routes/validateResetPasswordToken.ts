import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/util';
import moment from 'moment';

export const validateResetPasswordToken: Route = {
  path: routes.validateResetToken.path,
  method: routes.validateResetToken.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger('validateResetToken');
    const { token } = request.query;
    const db = getDbAsSystem();

    if (!token) {
      response.status(400).send({ isValid: false, message: 'No token provided' });
      return;
    }

    // Find user with the given reset token
    const user = await db.get(tables.User, { passwordResetToken: token });
    if (!user) {
      logger.info(`Invalid reset token used: ${token}`);
      response.status(200).send({ isValid: false, message: 'Invalid token' });
      return;
    }

    // Check if token is expired
    const currentTime = moment();
    const tokenExpiration = moment(user.passwordResetTokenExpiration);
    if (currentTime.isAfter(tokenExpiration)) {
      logger.info(`Expired reset token used for user: ${user.email}`);
      response.status(200).send({ isValid: false, message: 'Token has expired' });
      return;
    }

    response.status(200).send({ isValid: true });
  },
};
