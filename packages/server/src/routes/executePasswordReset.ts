import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { PasswordHasher } from '../authentication/PasswordHasher';
import { PasswordResetToken } from '../authentication/PasswordResetToken';
import { signInThrottle } from '../throttle/SignInThrottle';

/**
 * Route handler for executing a password reset.
 *
 * Resolves the presented token through `PasswordResetToken` — which refuses anything but a
 * well-formed token before any lookup — checks its expiry, and redeems it: the new password is
 * written and the token cleared in one conditional update, so a token resets a password once.
 * The token itself never reaches the log. A request that carries no body at all is refused like
 * one that carries a blank password.
 *
 * A redeemed link also opens the account's sign-in window again (`SignInThrottle`): the person
 * just proved the mailbox, so a reset made while wrong guesses held the door shut lets the new
 * password in at once instead of waiting the window out.
 *
 * @bodyParam {string} token - The password reset token.
 * @bodyParam {string} newPassword - The new password for the user.
 */
export const executePasswordReset: Route = {
  path: routes.executePasswordReset.path,
  method: routes.executePasswordReset.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger({ name: 'executePasswordReset' });
    const digests = new RequestDigests();
    const { token, newPassword } = request.body ?? {};
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      response.status(400).send({ error: 'New password cannot be blank' });
      return;
    }

    const resetToken = new PasswordResetToken();
    const resolution = await resetToken.resolve(token);
    if (resolution.status === 'malformed' || resolution.status === 'unknown') {
      logger.info({
        message: `Invalid reset token used`,
        obj: { reason: resolution.status, token: resetToken.fingerprint(token) },
      });
      response.status(400).send({ error: 'Invalid or expired reset token' });
      return;
    }

    if (resolution.status === 'expired') {
      logger.info({ message: `Expired reset token used`, obj: { account: digests.account(resolution.user.email) } });
      response.status(400).send({ error: 'Reset token has expired' });
      return;
    }

    const { user } = resolution;
    const hashedPassword = await new PasswordHasher().hash(newPassword);
    if (!(await resetToken.redeem(user, resolution.token, hashedPassword))) {
      logger.info({ message: `Reset token already redeemed`, obj: { account: digests.account(user.email) } });
      response.status(400).send({ error: 'Invalid or expired reset token' });
      return;
    }

    signInThrottle.recordSuccess(digests.account(user.email));
    logger.info({ message: `Password successfully reset`, obj: { account: digests.account(user.email) } });
    response.send({ message: 'Password has been successfully reset' });
  },
};
