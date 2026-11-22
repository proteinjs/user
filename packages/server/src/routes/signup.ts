import { Route } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { UserAuth, UserSignup, routes } from '@proteinjs/user';
import { BlankCredentials } from '../authentication/BlankCredentials';
import { PasswordSession } from '../authentication/PasswordSession';
import { DisposableEmailDomains } from '../services/DisposableEmailDomains';
import { Signup } from '../services/Signup';
import { getDefaultSignupGuard, SignupGuardFacts } from '../services/SignupGuard';
import { ClientAddress } from '../throttle/ClientAddress';

const logger = new Logger({ name: 'signup' });

/**
 * The request body: `UserSignup` (+ an optional invite `token`; the invite carries the email on
 * that path), and the two fields a form may carry for the consumer's guard — read here, judged
 * by the guard, never by this route.
 */
type SignupSubmission = Partial<UserSignup> & {
  token?: string;
  /** The honeypot field — no person sees it, so a value in it is bot-shaped. */
  website?: unknown;
  /** The render-moment token a form carries when the consumer's posture mints one. */
  formToken?: unknown;
};

/**
 * `POST /user/signup` — create the account AND establish its session in the same request
 * (auto-login), so a new user lands in the app instead of being bounced to the login form to
 * re-type the credentials they just submitted. Signup lives at the route layer beside login
 * because session establishment is a request-level concern services never see; the domain flow
 * (invite validation, account creation, notification emails) stays owned by `Signup.createUser`.
 *
 * Body: `SignupSubmission`. Response mirrors the login route's contract: 200 with `{}` on
 * success, `{ error }` with user-readable copy otherwise.
 *
 * When the email is already registered the response is byte-identical to success but NO session
 * is minted — auto-login must never hand out a session for an account the caller didn't just
 * create; the caller falls through to the login screen exactly as before. Existence is reported
 * to the mailbox owner by email, never to the caller. Where the product asks for the email
 * confirmation, an address held by an account that still waits is no such case: the sign-up starts
 * that account over (`Signup.createAccount`) and its session is made as for a new account.
 *
 * Without an invite the email and the password are asked (the name is not: the account is made with
 * an empty name, which the person may set later), and a blank one is answered with the log-in
 * route's own sentence (`BlankCredentials`); with an invite the name and the password are asked, as
 * the invite form sends them. A request that is already signed in and carries no invite makes no
 * account and keeps its session: it is answered as a success, so the page lands on Home.
 *
 * The session is made on the password this sign-up stored (`PasswordSession`): where the account no
 * longer holds that password once the session is saved (a later sign-up for the address started the
 * account over while this one was still at work), the session is ended, so two sign-ups for one
 * address at the same moment end as two in a row. The caller is answered as ever.
 *
 * The NO-INVITE road passes three doors before any write, in this order: the product's invite rule
 * asked about the address (`Signup.inviteRequiredOf`, refused with the rule's own sentence), the
 * throwaway-mail list (`DisposableEmailDomains`, refused with its one sentence) and the consumer's registered
 * `DefaultSignupGuard`, handed the submission's facts (`SignupGuardFacts`) — `refuse` answers
 * `{ error: sentence }`, `drop` answers exactly as success, and neither writes an account or
 * mints a session. The invite road passes neither: an invited address was chosen by an admin.
 */
export const signup: Route = {
  path: routes.signup.path,
  method: routes.signup.method,
  onRequest: async (request: any, response): Promise<void> => {
    const body: SignupSubmission = request.body ?? {};
    const email = typeof body.email === 'string' ? body.email.trim() : undefined;
    if (body.token) {
      if (!body.name || !body.password) {
        response.send({ error: 'Name and password cannot be blank' });
        return;
      }
    } else if (!email || !body.password) {
      response.send({ error: BlankCredentials.REFUSAL });
      return;
    }

    const digests = new RequestDigests();
    if (!body.token && email) {
      if (UserAuth.isLoggedIn()) {
        response.send({});
        return;
      }

      let inviteRequired: string | undefined;
      try {
        inviteRequired = await new Signup().inviteRequiredOf(email.toLowerCase());
      } catch (error: any) {
        answerFailure(response, digests, error);
        return;
      }
      if (inviteRequired) {
        logger.info({ message: 'Signup refused: an invite is required', obj: { account: digests.account(email) } });
        response.send({ error: inviteRequired });
        return;
      }

      if (new DisposableEmailDomains().isDisposable(email)) {
        logger.info({ message: 'Signup refused: throwaway-mail domain', obj: { account: digests.account(email) } });
        response.send({ error: DisposableEmailDomains.REFUSAL });
        return;
      }

      const facts = signupFacts(request, body, email);
      const verdict = await getDefaultSignupGuard().check(facts);
      if (verdict.verdict !== 'allow') {
        logger.info({
          message: `Signup ${verdict.verdict === 'refuse' ? 'refused' : 'dropped'} by the guard`,
          obj: { account: digests.account(email), device: facts.clientDevice },
        });
        // A drop answers exactly as success: the caller learns nothing it can iterate against.
        response.send(verdict.verdict === 'refuse' ? { error: verdict.sentence } : {});
        return;
      }
    }

    let result;
    try {
      result = await new Signup().createUser({ name: body.name, email, password: body.password }, body.token);
    } catch (error: any) {
      answerFailure(response, digests, error);
      return;
    }

    if (result.outcome === 'created' || result.outcome === 'startedOver') {
      const session = new PasswordSession(result.email, { stored: result.stored, typed: body.password });
      if (!(await session.establish(request))) {
        logger.info({
          message: 'Signup: the account was started over by a later sign-up, so this one keeps no session',
          obj: { account: digests.account(result.email) },
        });
      }
    }

    response.send({});
  },
};

/** The facts the guard judges — the address lowercased, the form's two optional fields as sent, the device as a digest. */
const signupFacts = (request: any, body: SignupSubmission, email: string): SignupGuardFacts => ({
  email: email.toLowerCase(),
  honeypot: typeof body.website === 'string' ? body.website : undefined,
  formToken: typeof body.formToken === 'string' ? body.formToken : undefined,
  clientDevice: new RequestDigests().coarseIp(new ClientAddress().of(request)),
  hasUserAgent: Boolean(request.headers?.['user-agent']),
});

/**
 * A failure of `createUser` or of the invite rule: createUser throws plain-words errors deliberately
 * (invite expired / invite required / email missing); the message is the user-facing contract, same as
 * the RPC layer's. The log gets the error through the digest door: a concurrent double sign-up's
 * unique-index refusal names the address in the database's own words.
 */
const answerFailure = (response: any, digests: RequestDigests, error: unknown): void => {
  logger.error({ message: 'Signup failed', error: digests.redactError(error) });
  response.send({ error: error instanceof Error ? error.message : 'Sign up failed.' });
};
