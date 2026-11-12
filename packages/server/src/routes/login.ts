import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { routes, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { WRONG_CREDENTIALS, authenticate, checkPassword } from '../authentication/authenticate';
import { DefaultAdminCredentials } from '../authentication/DefaultAdminCredentials';
import { establishSession } from '../authentication/establishSession';
import { SecondFactorGate, SecondFactorRecord } from '../authentication/SecondFactorGate';
import { SignInSecondStep, SignInSecondStepKind } from '../authentication/passkeys/SignInSecondStep';
import { AccountDeletion } from '../services/AccountDeletion';
import { ClientAddress } from '../throttle/ClientAddress';
import { RequestDigests } from '../throttle/RequestDigests';
import { SignInThrottle, signInThrottle } from '../throttle/SignInThrottle';

/**
 * `POST /user/login`. One door, three bodies:
 * 1. `{ email, password }` — the password step. For an account that need not use a passkey it
 *    opens the session, as it always has. For one that must (`SecondFactorGate.mustUse`) a correct
 *    password opens NO session: the door answers `{ secondStep }` — the passkey step the page runs
 *    next (`SignInSecondStep`) — and nothing of the sign-in has happened yet, the pending-deletion
 *    restore included.
 * 2. `{ passkey }` — an assertion answering the passkey step.
 * 3. `{ addPasskey }` — the registration of the account's first passkey, answering the add step.
 * A second-step body carries no address: the step's cookie names its challenge and the challenge
 * names the account. It answers one of three shapes and no other: `{}` (the session is open),
 * `{ error, secondStep }` (refused, with a new challenge) or `{ error, restart: true }` (the step
 * is over; back to the password) — the last also when the step PASSED and the session then cannot
 * open (the account is being purged, or its restore failed): the challenge is spent and the cookie
 * gone by then, so the page is sent back to the password, never left on a step that is over.
 * A failure thrown INSIDE a step (a write the database refuses) is none of the three: the door
 * throws, as the password step does. The framework catches a route's throw, writes it to the
 * process's error stream and passes the request on unanswered (@proteinjs/server `loadRoutes`:
 * `wrapRoute` catches, logs and calls `next()`), so nothing of the door's is sent and express's
 * own last handler answers it — a 404 with a page of its own, no JSON. The page treats any answer
 * that is not a 200 as restart, the step's challenge being spent by then.
 *
 * Whether a passkey is owed is `SecondFactorGate.mustUse`'s answer alone; the door reads no
 * declaration to decide it. The built-in default admin (`DefaultAdminCredentials`: no account row,
 * so no passkey) is refused where one is owed, in the words any wrong try is told, with one
 * warning line for the operator — never given a session that would resolve as nobody.
 *
 * Throttled per client and per account (`SignInThrottle`): a throttled try is told "Too many
 * attempts. Try again in a few minutes." whether or not the address has an account, after the
 * same password check a refusal runs (verdict discarded), so neither the words nor the timing
 * tell. A second-step body is counted against the client alone — it names no account. Every
 * refusal is a "Sign-in refused" line and every throttled try its own "Sign-in throttled" line,
 * carrying the account digest and the coarse IP hash (`RequestDigests`) — never the address.
 */
export const login: Route = {
  path: routes.login.path,
  method: routes.login.method,
  onRequest: async (request: any, response): Promise<void> => {
    await new SignInDoor(request, response).answer();
  },
};

/** One request at the sign-in door. */
class SignInDoor {
  private readonly logger = new Logger({ name: 'login' });
  private readonly digests = new RequestDigests();
  private readonly ip: string;

  constructor(
    private readonly request: any,
    private readonly response: any
  ) {
    this.ip = this.digests.coarseIp(new ClientAddress().of(request));
  }

  async answer(): Promise<void> {
    const body = this.request.body ?? {};
    const secondStep = SignInSecondStep.kindOf(body);
    if (secondStep) {
      await this.secondStep(secondStep, body[secondStep]);
      return;
    }

    await this.password(body);
  }

  /** Body 1: the address and the password. */
  private async password(credentials: any): Promise<void> {
    // A field that is not text is a blank one — never something to call methods on.
    const email: string = typeof credentials.email === 'string' ? credentials.email : '';
    const password: string = typeof credentials.password === 'string' ? credentials.password : '';
    const account = email ? this.digests.account(email) : undefined;
    const fields = account ? { account, ip: this.ip } : { ip: this.ip };

    // The account is counted only when a password came with the try: a blank one judges nothing.
    const window = await signInThrottle.admit(this.ip, password ? account : undefined);
    if (window) {
      await checkPassword(email, password);
      this.logger.warn({ message: 'Sign-in throttled', obj: { ...fields, window } });
      this.response.send({ error: SignInThrottle.ANSWER });
      return;
    }

    if (!email || !password || !account) {
      const error = `Email and password cannot be blank`;
      this.logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: error } });
      this.response.send({ error });
      return;
    }

    const result = await authenticate(email, password);
    if (result !== true) {
      this.logger.info({ message: 'Sign-in refused', obj: { ...fields, reason: result } });
      this.response.send({ error: result });
      return;
    }

    // Who the address signs in as is who a session bound to it resolves as (`userCache`): the
    // built-in default admin, or the account row. The default admin has no account row, so it can
    // hold no passkey: where it must use one it is refused as any wrong try is (and counted as
    // one) — a session of it would resolve as nobody on its first request. The line says why, for
    // the operator.
    const gate = new SecondFactorGate();
    const address = email.toLowerCase();
    const defaultAdmin = DefaultAdminCredentials.identityOf(address);
    if (defaultAdmin && gate.mustUse(defaultAdmin)) {
      const reason =
        'the built-in default admin cannot sign in where passkeys are required: make an account that holds the admin role';
      this.logger.warn({ message: 'Sign-in refused', obj: { ...fields, reason } });
      this.response.send({ error: WRONG_CREDENTIALS });
      return;
    }
    await signInThrottle.recordSuccess(account, this.ip);

    // The password alone opens a session only for an account that need not use a passkey. One
    // that must is answered the passkey step instead: no restore, no session.
    const user = defaultAdmin ? undefined : await getDbAsSystem().get(tables.User, { email: address });
    if (user && gate.mustUse(user)) {
      this.response.send({ secondStep: await new SignInSecondStep(this.request, this.response).begin(user) });
      return;
    }

    const refusal = await this.openSession(email);
    this.response.send(refusal ? { error: refusal } : {});
  }

  /** Bodies 2 and 3: the passkey step's answer. Counted against the client alone — it names no account. */
  private async secondStep(kind: SignInSecondStepKind, ceremonyResponse: unknown): Promise<void> {
    const step = new SignInSecondStep(this.request, this.response);
    if (await signInThrottle.admit(this.ip)) {
      step.abandon();
      this.logger.warn({ message: 'Sign-in throttled', obj: { ip: this.ip, window: 'client' } });
      this.response.send({ error: SignInThrottle.ANSWER, restart: true });
      return;
    }

    const outcome = await step.finish(kind, ceremonyResponse);
    if (outcome.status !== 'passed') {
      const account = outcome.account ? { account: this.digests.account(outcome.account.email) } : {};
      this.logger.info({ message: 'Sign-in refused', obj: { ...account, ip: this.ip, reason: outcome.reason } });
      this.response.send(
        outcome.status === 'again'
          ? { error: outcome.error, secondStep: outcome.secondStep }
          : { error: outcome.error, restart: true }
      );
      return;
    }

    // The step passed: its try is forgiven, as a password's is. If the session then cannot open,
    // the step is over all the same (its challenge is spent, its cookie cleared): restart.
    await signInThrottle.recordSuccess(this.digests.account(outcome.account.email), this.ip);
    const refusal = await this.openSession(outcome.account.email, outcome.secondFactor);
    this.response.send(refusal ? { error: refusal, restart: true } : {});
  }

  /**
   * The end of every sign-in that succeeds, whichever body finished it: the pending-deletion
   * restore, then the session — carrying the second factor's record when a passkey step proved one.
   * Resolves to the words the sign-in is refused with when the session cannot open (the restore
   * failed; the account is being purged) — the caller answers them in its own body's shape — and
   * to undefined once the session is open.
   */
  private async openSession(email: string, secondFactor?: SecondFactorRecord): Promise<string | undefined> {
    // Cancel-by-login: a pending-deletion account's successful sign-in IS the cancel signal. The
    // restore runs synchronously here, BEFORE request.login, so the first authenticated paint sees
    // the fully restored account (no transient). For an account that must use a passkey this is
    // after the passkey step, never on the password alone: whoever holds only the password does
    // not get to cancel the deletion.
    let outcome: Awaited<ReturnType<AccountDeletion['cancelPendingDeletion']>>;
    try {
      outcome = await new AccountDeletion().cancelPendingDeletion(email);
    } catch (error) {
      // Security boundary: the login response never carries internal error detail — an
      // attacker probing emails must learn nothing from failure shapes (founder ruling
      // 2026-08-18 after a watcher error surfaced verbatim in the login form). The real
      // error stays loud in the server log.
      console.error('cancelPendingDeletion failed during login', error);
      return 'Unable to log in right now. Please try again.';
    }
    if (outcome === 'purging') {
      const error = 'This account is being deleted and can no longer be restored.';
      console.error(error);
      return error;
    }

    await establishSession(this.request, email, { secondFactor });
    return undefined;
  }
}
