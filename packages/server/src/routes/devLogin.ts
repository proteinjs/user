import { Route } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';
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

    await new Promise((resolve) => request.login(email, resolve));
    // Explicit save before redirecting: with a DB-backed session store, save-on-response-end
    // races the redirected GET / — the follow-up request can read the session row before the
    // write commits and render the login page (observed: first /dev/login load lands on /login,
    // second succeeds). Awaiting the store write closes the race.
    await new Promise((resolve) => request.session.save(resolve));
    logger.info({ message: 'Dev auto-login session established', obj: { email } });
    response.redirect('/');
  },
};
