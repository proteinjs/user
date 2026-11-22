import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { checkPassword, INCORRECT_CREDENTIALS, judgeCredentials } from '../authentication/authenticate';
import { BlankCredentials } from '../authentication/BlankCredentials';
import { establishSession } from '../authentication/establishSession';
import { PasswordSession } from '../authentication/PasswordSession';
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
 *
 * The session is made on the password this log-in judged (`PasswordSession`): where the account no
 * longer holds that password once the session is saved, the session is ended and the log-in is answered
 * as one whose password is not the account's.
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
      const error = BlankCredentials.REFUSAL;
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: error } });
      response.send({ error });
      return;
    }

    const judgment = await judgeCredentials(email, password);
    if (judgment.refusal !== undefined) {
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: judgment.refusal } });
      response.send({ error: judgment.refusal });
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

    // The default admin has no account row, so no password a row could stop holding: its session is made as it is.
    if (judgment.stored === undefined) {
      await establishSession(request, email);
    } else if (!(await new PasswordSession(email, { stored: judgment.stored, typed: password }).establish(request))) {
      logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: INCORRECT_CREDENTIALS } });
      response.send({ error: INCORRECT_CREDENTIALS });
      return;
    }
    response.send({});
  },
};
