import { Route } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';
import { UserSignup, routes } from '@proteinjs/user';
import { establishSession } from '../authentication/establishSession';
import { Signup } from '../services/Signup';

const logger = new Logger({ name: 'signup' });

/**
 * `POST /user/signup` — create the account AND establish its session in the same request
 * (auto-login), so a new user lands in the app instead of being bounced to the login form to
 * re-type the credentials they just submitted. Signup lives at the route layer beside login
 * because session establishment is a request-level concern services never see; the domain flow
 * (invite validation, account creation, notification emails) stays owned by `Signup.createUser`.
 *
 * Body: `UserSignup` (+ optional invite `token`; the invite carries the email on that path).
 * Response mirrors the login route's contract: 200 with `{}` on success, `{ error }` with
 * user-readable copy otherwise.
 *
 * When the email is already registered the response is byte-identical to success but NO session
 * is minted — auto-login must never hand out a session for an account the caller didn't just
 * create; the caller falls through to the login screen exactly as before. Existence is reported
 * to the mailbox owner by email, never to the caller.
 */
export const signup: Route = {
  path: routes.signup.path,
  method: routes.signup.method,
  onRequest: async (request: any, response): Promise<void> => {
    const body: Partial<UserSignup> & { token?: string } = request.body ?? {};
    if (!body.name || !body.password) {
      response.send({ error: 'Name and password cannot be blank' });
      return;
    }

    let result;
    try {
      result = await new Signup().createUser(
        { name: body.name, email: body.email, password: body.password },
        body.token
      );
    } catch (error: any) {
      // createUser throws plain-words errors deliberately (invite expired / invite required /
      // email missing); the message is the user-facing contract, same as the RPC layer's.
      logger.error({ message: 'Signup failed', error });
      response.send({ error: error instanceof Error ? error.message : 'Sign up failed.' });
      return;
    }

    if (result.outcome === 'created') {
      await establishSession(request, result.email);
    }

    response.send({});
  },
};
