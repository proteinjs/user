import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { AccountSessions } from '../authentication/AccountSessions';
import { PasswordHasher } from '../authentication/PasswordHasher';
import { PasswordResetToken } from '../authentication/PasswordResetToken';
import { PasswordRules } from '../authentication/PasswordRules';
import { signInThrottle } from '../throttle/SignInThrottle';

/**
 * Route handler for executing a password reset.
 *
 * Resolves the presented token through `PasswordResetToken` — which refuses anything but a
 * well-formed token before any lookup — checks its expiry, and redeems it: the new password is
 * written and the token cleared in one conditional update, so a token resets a password once.
 * The token itself never reaches the log. A request that carries no body at all is refused like
 * one that carries a blank password (or one that is no text), and so is a password the server's
 * rules refuse (`PasswordRules`: blank first, then the shared minimum length, the common-passwords
 * list) — before the token is resolved, so a refused password consumes nothing.
 *
 * A redeemed link also opens the account's sign-in window again (`SignInThrottle`): the person
 * just proved the mailbox, so a reset made while wrong guesses held the door shut lets the new
 * password in at once instead of waiting the window out. And it ends EVERY session of the
 * account (`AccountSessions`): a reset is what someone does when the old password may be in other
 * hands, so a device holding a session opened under it signs out; the person signs in anew.
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
    // Blank, no text at all, too short, too common: one check, refused before the token is resolved.
    const passwordRefusal = new PasswordRules().check(newPassword);
    if (passwordRefusal) {
      response.status(400).send({ error: passwordRefusal });
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

    await signInThrottle.recordSuccess(digests.account(user.email));
    const sessionsEnded = await new AccountSessions().endAll(user.email);
    logger.info({
      message: `Password successfully reset`,
      obj: { account: digests.account(user.email), sessionsEnded },
    });
    response.send({ message: 'Password has been successfully reset' });
  },
};
