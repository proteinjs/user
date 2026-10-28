import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { EmailVerificationToken } from '../authentication/EmailVerificationToken';

/** What the route answers, for the page that called it: `{ state }`. */
export type VerifyEmailState = 'confirmed' | 'expired' | 'invalid';

/**
 * `GET /user/verify-email?token=` — confirms an account's email address from the token in its
 * mailed link. The link lands on the app's verify page (`uiRoutes.account.verifyEmail`), which
 * calls this route with the token and shows the state it answers, the way the password-reset
 * page calls its token routes: JSON, never a redirect.
 *
 * Resolves the presented token through `EmailVerificationToken` — which refuses anything but a
 * well-formed token before any lookup — checks its expiry, and spends it: `emailVerified` is
 * written and the token cleared in one conditional update, so a link confirms once.
 *   - 'confirmed': the address is now verified and the token spent;
 *   - 'expired': the link lapsed — the flag is unchanged; the account page's re-send mints a new one;
 *   - 'invalid': malformed, unknown, or already spent — the same word for all three, so the
 *     answer says nothing about whether a token ever existed.
 * A request with no token at all is refused (400, 'invalid'). Nothing in any answer names an
 * address, and the token itself never reaches the log.
 */
export const verifyEmail: Route = {
  path: routes.verifyEmail.path,
  method: routes.verifyEmail.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger({ name: 'verifyEmail' });
    const { token } = request.query ?? {};
    if (!token) {
      response.status(400).send({ state: 'invalid' satisfies VerifyEmailState });
      return;
    }

    const verification = new EmailVerificationToken();
    const resolution = await verification.resolve(token);
    if (resolution.status === 'malformed' || resolution.status === 'unknown') {
      logger.info({
        message: `Invalid email verification token used`,
        obj: { reason: resolution.status, token: verification.fingerprint(token) },
      });
      response.status(200).send({ state: 'invalid' satisfies VerifyEmailState });
      return;
    }

    const account = new RequestDigests().account(resolution.user.email);
    if (resolution.status === 'expired') {
      logger.info({ message: `Expired email verification token used`, obj: { account } });
      response.status(200).send({ state: 'expired' satisfies VerifyEmailState });
      return;
    }

    if (!(await verification.confirm(resolution.user, resolution.token))) {
      logger.info({ message: `Email verification token already spent`, obj: { account } });
      response.status(200).send({ state: 'invalid' satisfies VerifyEmailState });
      return;
    }

    logger.info({ message: `Email address verified`, obj: { account } });
    response.status(200).send({ state: 'confirmed' satisfies VerifyEmailState });
  },
};
