import { devLogin } from '../src/routes/devLogin';
import { createPassportRequest } from './passportSessionHarness';

/** What one `GET /dev/login` did, seen from outside: the session it minted (or not) and the response it sent. */
export type DevLoginOutcome = {
  loggedInAs?: string;
  sessionRegenerated: boolean;
  sessionSaved: boolean;
  status?: number;
  body?: unknown;
  redirect?: string;
};

/**
 * Drives the devLogin route once over the REAL passport login machinery (see
 * passportSessionHarness): the full session-establishment contract (regenerate → login → save)
 * is pinned by SignupRoute.test.ts — the dev-door suites assert the door INHERITS it.
 */
export const invokeDevLogin = async (query?: Record<string, unknown>): Promise<DevLoginOutcome> => {
  const { request, events } = await createPassportRequest({ query });
  const outcome: DevLoginOutcome = { sessionRegenerated: false, sessionSaved: false };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body;
    },
    redirect(path: string) {
      outcome.redirect = path;
    },
  };
  await devLogin.onRequest(request as never, response as never);
  outcome.loggedInAs = request.session.passport?.user;
  outcome.sessionRegenerated = events.includes('regenerate');
  outcome.sessionSaved = events.includes('save');
  return outcome;
};
