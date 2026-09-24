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
    const credentials = request.body ?? {};
    // A field that is not text is a blank one — never something to call methods on.
    const email: string = typeof credentials.email === 'string' ? credentials.email : '';
    const password: string = typeof credentials.password === 'string' ? credentials.password : '';
    const digests = new RequestDigests();
    const ip = digests.coarseIp(new ClientAddress().of(request));
    const account = email ? digests.account(email) : undefined;
    const fields = account ? { account, ip } : { ip };

    // The account is counted only when a password came with the try: a blank one judges nothing.
    const window = await signInThrottle.admit(ip, password ? account : undefined);
    if (window) {
      await checkPassword(email, password);
      logger.warn({ message: 'Sign-in throttled', obj: { ...fields, window } });
      response.send({ error: SignInThrottle.ANSWER });
      return;
    }

    if (!email || !password || !account) {
      const error = `Email and password cannot be blank`;
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: error } });
      response.send({ error });
      return;
    }

    const result = await authenticate(email, password);
    if (result !== true) {
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: result } });
      response.send({ error: result });
      return;
    }
    await signInThrottle.recordSuccess(account, ip);

    // Cancel-by-login: a pending-deletion account's successful authentication IS the cancel
    // signal. The restore runs synchronously here, BEFORE request.login, so the first
    // authenticated paint sees the fully restored account (no transient).
    let outcome: Awaited<ReturnType<AccountDeletion['cancelPendingDeletion']>>;
    try {
      outcome = await new AccountDeletion().cancelPendingDeletion(email);
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

    await establishSession(request, email);
    response.send({});
  },
};
