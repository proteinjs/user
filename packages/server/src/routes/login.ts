import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { authenticate, checkPassword } from '../authentication/authenticate';
import { establishSession } from '../authentication/establishSession';
import { AccountDeletion } from '../services/AccountDeletion';
import { ClientAddress } from '../throttle/ClientAddress';
import { RequestDigests } from '../throttle/RequestDigests';
import { SignInThrottle, signInThrottle } from '../throttle/SignInThrottle';

/**
 * `POST /user/login`. Throttled per client and per account (`SignInThrottle`): a throttled try
 * is told "Too many attempts. Try again in a few minutes." whether or not the address has an
 * account, after the same password check a refusal runs (verdict discarded), so neither the
 * words nor the timing tell. Every refusal is a "Sign-in refused" line and every throttled try
 * its own "Sign-in throttled" line, carrying the account digest and the coarse IP hash
 * (`RequestDigests`) — never the address.
 */
export const login: Route = {
  path: routes.login.path,
  method: routes.login.method,
  onRequest: async (request: any, response): Promise<void> => {
    const logger = new Logger({ name: 'login' });
    const credentials: { email?: string; password?: string } = request.body ?? {};
    const digests = new RequestDigests();
    const ip = digests.coarseIp(new ClientAddress().of(request));
    const account = credentials.email ? digests.account(credentials.email) : undefined;
    const fields = account ? { account, ip } : { ip };

    const window = signInThrottle.admit(ip, account);
    if (window) {
      await checkPassword(credentials.email ?? '', credentials.password ?? '');
      logger.warn({ message: 'Sign-in throttled', obj: { ...fields, window } });
      response.send({ error: SignInThrottle.ANSWER });
      return;
    }

    if (!credentials.email || !credentials.password || !account) {
      const error = `Email and password cannot be blank`;
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: error } });
      response.send({ error });
      return;
    }

    const result = await authenticate(credentials.email, credentials.password);
    if (result !== true) {
      signInThrottle.recordRefusal(account);
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: result } });
      response.send({ error: result });
      return;
    }
    signInThrottle.recordSuccess(account);

    // Cancel-by-login: a pending-deletion account's successful authentication IS the cancel
    // signal. The restore runs synchronously here, BEFORE request.login, so the first
    // authenticated paint sees the fully restored account (no transient).
    let outcome: Awaited<ReturnType<AccountDeletion['cancelPendingDeletion']>>;
    try {
      outcome = await new AccountDeletion().cancelPendingDeletion(credentials.email);
    } catch (error) {
      // Security boundary: the login response never carries internal error detail — an
      // attacker probing emails must learn nothing from failure shapes (founder ruling
      // 2026-08-18 after a watcher error surfaced verbatim in the login form). The real
      // error stays loud in the server log.
      console.error('cancelPendingDeletion failed during login', error);
      response.send({ error: 'Unable to log in right now. Please try again.' });
      return;
    }
    if (outcome === 'purging') {
      const error = 'This account is being deleted and can no longer be restored.';
      console.error(error);
      response.send({ error });
      return;
    }

    await establishSession(request, credentials.email);
    response.send({});
  },
};
