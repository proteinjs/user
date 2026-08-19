import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import moment from 'moment';

export const validateResetPasswordToken: Route = {
  path: routes.validateResetToken.path,
  method: routes.validateResetToken.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger({ name: 'validateResetToken' });
    const { token } = request.query;
    const db = getDbAsSystem();

    if (!token) {
      response.status(400).send({ isValid: false, message: 'No token provided' });
      return;
    }

    // Find user with the given reset token
    const user = await db.get(tables.User, { passwordResetToken: token });
    if (!user) {
      logger.info({ message: `Invalid reset token used`, obj: { token } });
      response.status(200).send({ isValid: false, message: 'Invalid token' });
      return;
    }

    // Check if token is expired
    const currentTime = moment();
    const tokenExpiration = moment(user.passwordResetTokenExpiration);
    if (currentTime.isAfter(tokenExpiration)) {
      logger.info({ message: `Expired reset token used`, obj: { email: user.email } });
      response.status(200).send({ isValid: false, message: 'Token has expired' });
      return;
    }

    // The account email rides the VALID response only: the reset page renders it as the
    // read-only `autocomplete="username"` field so password managers associate the updated
    // password with the stored credential. The token was delivered to this very inbox, so a
    // valid-token holder learns nothing new; invalid/expired verdicts stay email-free.
    response.status(200).send({ isValid: true, email: user.email });
  },
};
