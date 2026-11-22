import { Route } from '@proteinjs/server-api';
import { routes, VerifyEmailState } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { EmailVerificationToken } from '../authentication/EmailVerificationToken';
import { EmailConfirmation } from '../services/EmailConfirmation';
import { Signup } from '../services/Signup';

/**
 * `GET /user/verify-email?token=` — confirms an account's email address from the token in its
 * mailed link. The link lands on the app's verify page (`uiRoutes.account.verifyEmail`), which
 * calls this route with the token and follows the state it answers (`VerifyEmailState`), the way
 * the password-reset page calls its token routes: JSON, never a redirect.
 *
 * Resolves the presented token through `EmailVerificationToken` — which refuses anything but a
 * well-formed token before any lookup — checks its expiry, and spends it: `emailVerified` is
 * written and the token cleared in one conditional update, so a link confirms once.
 *   - 'confirmed': the address is now verified and the token spent;
 *   - 'expired': the link lapsed — the flag is unchanged; a re-send mints a new one;
 *   - 'invalid': malformed, unknown, or already spent — the same word for all three, so the
 *     answer says nothing about whether a token ever existed.
 * A request with no token at all is refused (400, 'invalid'). Nothing in any answer names an
 * address, and the token itself never reaches the log.
 *
 * WHERE THE EMAIL CONFIRMATION IS ASKED OF THE LINK'S ACCOUNT (`EmailConfirmation.isAskedOf`: the product
 * asks, and the account was asked as it was made), after those answers:
 *   - the link confirms only in its account's own session: the session's address must equal the
 *     address of the account the token was issued to, or the answer is 'logInFirst' and nothing is
 *     used up;
 *   - confirming ends no session and makes none: the account's other waiting sessions answer as the
 *     account from their next request;
 *   - where the write wins, the welcome mail goes, after the answer (the sign-up's own mail only
 *     confirmed); where it finds the link already used by a request at the same moment, the answer
 *     is 'confirmed' all the same, with no second welcome.
 * An account the confirmation is not asked of (one made before the product asked) is confirmed by its
 * link alone, exactly as where no product asks.
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

    const confirmation = new EmailConfirmation();
    const asked = confirmation.isAskedOf(resolution.user);
    if (asked && confirmation.sessionAddress() !== resolution.user.email.toLowerCase()) {
      logger.info({ message: `Email verification link opened outside its account's session`, obj: { account } });
      response.status(200).send({ state: 'logInFirst' satisfies VerifyEmailState });
      return;
    }

    const wonTheWrite = await verification.confirm(resolution.user, resolution.token);
    if (!wonTheWrite && !asked) {
      logger.info({ message: `Email verification token already spent`, obj: { account } });
      response.status(200).send({ state: 'invalid' satisfies VerifyEmailState });
      return;
    }

    logger.info({
      message: wonTheWrite ? `Email address verified` : `Email verification link used by a request at the same moment`,
      obj: { account },
    });
    response.status(200).send({ state: 'confirmed' satisfies VerifyEmailState });
    // After the answer: the page's wait is the write, never the mail.
    if (wonTheWrite && asked) {
      await new Signup().welcomeConfirmed(resolution.user.email);
    }
  },
};
