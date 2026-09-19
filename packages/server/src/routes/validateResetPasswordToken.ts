import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { PasswordResetToken } from '../authentication/PasswordResetToken';

export const validateResetPasswordToken: Route = {
  path: routes.validateResetToken.path,
  method: routes.validateResetToken.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger({ name: 'validateResetToken' });
    const { token } = request.query;
    if (!token) {
      response.status(400).send({ isValid: false, message: 'No token provided' });
      return;
    }

    const resetToken = new PasswordResetToken();
    const resolution = await resetToken.resolve(token);
    if (resolution.status === 'malformed' || resolution.status === 'unknown') {
      logger.info({
        message: `Invalid reset token used`,
        obj: { reason: resolution.status, token: resetToken.fingerprint(token) },
      });
      response.status(200).send({ isValid: false, message: 'Invalid token' });
      return;
    }

    if (resolution.status === 'expired') {
      logger.info({ message: `Expired reset token used`, obj: { email: resolution.user.email } });
      response.status(200).send({ isValid: false, message: 'Token has expired' });
      return;
    }

    // The account email rides the VALID response only: the reset page renders it as the
    // read-only `autocomplete="username"` field so password managers associate the updated
    // password with the stored credential. The token was delivered to this very inbox, so a
    // valid-token holder learns nothing new; invalid/expired verdicts stay email-free.
    response.status(200).send({ isValid: true, email: resolution.user.email });
  },
};
