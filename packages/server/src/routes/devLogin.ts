import { Route } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';

const logger = new Logger({ name: 'devLogin' });

/**
 * DEV-ONLY session bootstrap: `GET /dev/login` establishes a session for the account named by
 * `DEV_AUTO_LOGIN_EMAIL` — no credentials involved — so automated dev-loop testing (agent-driven
 * browsers) can self-serve a session instead of stalling on the login form every time a cookie
 * is lost.
 *
 * Double-gated, acts only when BOTH hold; otherwise the path answers 404 as if unregistered:
 * 1. `process.env.DEVELOPMENT` — the dev-server switch, never set in prod images.
 * 2. `DEV_AUTO_LOGIN_EMAIL` — explicit per-launch opt-in naming exactly one account.
 */
export const devLogin: Route = {
  path: '/dev/login',
  method: 'get',
  onRequest: async (request: any, response): Promise<void> => {
    const email = (process.env.DEV_AUTO_LOGIN_EMAIL ?? '').trim();
    if (!process.env.DEVELOPMENT || !email) {
      response.status(404).send();
      return;
    }

    await new Promise((resolve) => request.login(email, resolve));
    logger.info({ message: 'Dev auto-login session established', obj: { email } });
    response.redirect('/');
  },
};
