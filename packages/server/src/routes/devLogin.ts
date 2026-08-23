import { Route } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';
import { emailRegex } from '@proteinjs/util';
import { establishSession } from '../authentication/establishSession';
import { Signup } from '../services/Signup';

const logger = new Logger({ name: 'devLogin' });

/** Lowercased domain of an email address (the whole string when there is no `@`, which can never
 *  equal a real env domain — so malformed params fall out at the domain rail). */
const emailDomain = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/**
 * DEV-ONLY session bootstrap: `GET /dev/login` establishes a session — no credentials involved —
 * so automated dev-loop testing (agent-driven browsers) can self-serve a session instead of
 * stalling on the login form. `?email=<addr>` selects the session's account so parallel
 * verification can fan out over distinct users; absent, the `DEV_AUTO_LOGIN_EMAIL` account is
 * used as before.
 *
 * Double-gated, acts only when BOTH hold; otherwise the path answers 404 as if unregistered:
 * 1. `process.env.DEVELOPMENT` — the dev-server switch, never set in prod images.
 * 2. `DEV_AUTO_LOGIN_EMAIL` — explicit per-launch opt-in naming the default account.
 *
 * Domain rail: `?email` must share `DEV_AUTO_LOGIN_EMAIL`'s domain — even a dev server must not
 * mint sessions (much less accounts) for arbitrary domains; anything else answers 400.
 *
 * Shape rail: `?email` must be a well-formed address (the house `emailRegex`). The domain rail
 * alone let `?email=brent+lane-a@…` through when the `+` was left unencoded — a query-string `+`
 * decodes to a SPACE, so the route minted a stray `brent lane-a@…` account. The 400 names the
 * remedy (`%2B`) because plus-addressing is the fan-out convention this door exists for.
 *
 * A missing account is created through the normal signup creation path (`Signup.createAccount`)
 * as a normal test user — password `test`, matching the seeded test-account convention, so
 * interactive login works for the same identity. Composes with userCache's missing-account→guest
 * seam: that covers sessions whose account was deleted AFTER minting; this ensures dev-minted
 * sessions reference a real account from the start.
 */
export const devLogin: Route = {
  path: '/dev/login',
  method: 'get',
  onRequest: async (request: any, response): Promise<void> => {
    const envEmail = (process.env.DEV_AUTO_LOGIN_EMAIL ?? '').trim();
    if (!process.env.DEVELOPMENT || !envEmail) {
      response.status(404).send();
      return;
    }

    let email = envEmail;
    const emailParam = request.query?.email;
    if (emailParam !== undefined) {
      const requested = typeof emailParam === 'string' ? emailParam.trim() : '';
      if (emailDomain(requested) !== emailDomain(envEmail)) {
        response.status(400).send(`/dev/login only accepts accounts on the @${emailDomain(envEmail)} domain`);
        return;
      }
      if (!emailRegex.test(requested)) {
        response
          .status(400)
          .send(
            `/dev/login: "${requested}" is not a valid email address — an unencoded "+" in the query ` +
              `decodes to a space; write it as %2B (e.g. ?email=name%2Blane@${emailDomain(envEmail)})`
          );
        return;
      }
      email = requested;
    }
    email = email.toLowerCase();

    const creation = await new Signup().createAccount({
      name: email.slice(0, email.indexOf('@')),
      email,
      password: 'test',
      emailVerified: false, // same shape an inviteless signup produces
      invitedBy: null,
    });
    if (creation === 'created') {
      logger.info({ message: 'Dev auto-login created missing test account', obj: { email } });
    }

    // establishSession commits the session row before the redirect — the redirected GET / must
    // never read the store ahead of the write (observed: first /dev/login load landed on /login).
    await establishSession(request, email);
    logger.info({ message: 'Dev auto-login session established', obj: { email } });
    response.redirect('/');
  },
};
