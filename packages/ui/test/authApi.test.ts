import { AuthApi } from '../src/auth/AuthApi';
import { routes } from '@proteinjs/user';

function mockFetch(response: { status?: number; statusText?: string; body?: any; notJson?: boolean }) {
  const fetchMock = jest.fn().mockResolvedValue({
    status: response.status ?? 200,
    statusText: response.statusText ?? 'OK',
    json: async () => {
      if (response.notJson) {
        throw new SyntaxError('Unexpected token < in JSON');
      }
      return response.body ?? {};
    },
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

afterEach(() => {
  delete (global as any).fetch;
});

describe('AuthApi.login', () => {
  it('posts the credentials to the login route and resolves on success', async () => {
    const fetchMock = mockFetch({ body: {} });
    await new AuthApi().login('ada@example.com', 'hunter22');
    expect(fetchMock).toHaveBeenCalledWith(
      routes.login.path,
      expect.objectContaining({
        method: routes.login.method,
        body: JSON.stringify({ email: 'ada@example.com', password: 'hunter22' }),
      })
    );
  });

  it("a refused sign-in throws the door's own line, whatever its status — the generic words only when the body carries none", async () => {
    mockFetch({ status: 401, statusText: 'Unauthorized', body: { error: 'Incorrect email or password' } });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow('Incorrect email or password');

    // No line in the body: the client's one generic line, on a refusal's status as on a 200 — never
    // the status text (this assertion replaces "Failed to log in, error: <status text>").
    for (const noLine of [
      { status: 401, statusText: 'Unauthorized' },
      { status: 502, statusText: '', notJson: true },
    ]) {
      mockFetch(noLine);
      const told = await new AuthApi().login('ada@example.com', 'nope').then(
        () => 'an open session',
        (failure: Error) => failure.message
      );
      expect(told).toBe(AuthApi.LOGIN_FAILED);
    }
  });

  it('throws the server-provided error from a 200 response body', async () => {
    mockFetch({ body: { error: 'Incorrect email or password' } });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow('Incorrect email or password');
  });
});

/**
 * The door's own line reaches the person on every password road. A route refuses in user-readable
 * words — `{ error }` on a 400 as on a 200 (the reset's redeem answers 400 for a password the
 * server's rules refuse: "That password is too common", and for a link no longer live) — and the
 * api throws THAT line; the generic words stand only for an answer with no line in it.
 */
/**
 * The passkey step of a sign-in. For an account that must use a passkey the door answers the
 * password with a step instead of a session; the page runs it on the device and posts what the
 * device's sheet answered to the same door, whose answer is one of three: the session is open, a
 * new step with a line, or the step is over with a line. Anything else the step's answer could be
 * — the limit in front of the door, a step that failed on the server, a 200 that is not the door's
 * own empty answer — means it is over: the session is open on `{}` and on nothing else. The
 * password step reads the door the same way: what is no open session and no step the page can run
 * is a sign-in that failed.
 */
describe('AuthApi — the passkey step of a sign-in', () => {
  const STEP = { kind: 'passkey', options: { challenge: 'the-first-challenge', rpId: 'example.test' } };
  const NEXT = { kind: 'passkey', options: { challenge: 'the-next-challenge', rpId: 'example.test' } };
  const ADD = { kind: 'addPasskey', options: { challenge: 'a-creation-challenge', rp: { name: 'Example' } } };
  const assertion = { id: 'a-credential', type: 'public-key' } as never;
  const registration = { id: 'a-new-credential', type: 'public-key' } as never;
  const posted = (fetchMock: jest.Mock) => fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(init.body)]);

  /** The door answers 200 with exactly `body` — whatever it is, nothing included. */
  const doorAnswers = (body: unknown) => {
    (global as any).fetch = jest.fn().mockResolvedValue({ status: 200, statusText: 'OK', json: async () => body });
  };

  /** A 200 in no shape the door sends: not its empty answer, not a step the page can run, and no line of the door's. */
  const STRANGERS: unknown[] = [
    null,
    [],
    [{}],
    'ok',
    true,
    { secondStep: { kind: 'somethingElse', options: {} } },
    { secondStep: { kind: 'passkey' } },
    { restart: false },
    { ok: true },
    { error: '   ' },
  ];

  it('login resolves with the step when the door answers one, and with nothing when the session is open', async () => {
    mockFetch({ body: { secondStep: STEP } });
    await expect(new AuthApi().login('ada@example.com', 'hunter22')).resolves.toEqual(STEP);
    mockFetch({ body: { secondStep: ADD } });
    await expect(new AuthApi().login('ada@example.com', 'hunter22')).resolves.toEqual(ADD);
    mockFetch({ body: {} });
    await expect(new AuthApi().login('ada@example.com', 'hunter22')).resolves.toBeUndefined();
    // A step with a line beside it is still the step at the password step.
    mockFetch({ body: { secondStep: STEP, error: 'a line beside the step' } });
    await expect(new AuthApi().login('ada@example.com', 'hunter22')).resolves.toEqual(STEP);
  });

  // This case replaces the assertion "a step in no shape the page can run is no step": that one
  // resolved with nothing, which the page reads as an open session.
  it("the password step reads the door's answer closed, as the passkey step does: a 200 in no shape the door sends — nothing, a list, text, a step of a kind the page cannot run, an answer with something else in it, a body that is no JSON — is a sign-in that failed, told in one line of the client's own and never in an exception's words; none is an open session, and none hands the page a step", async () => {
    const signIn = () =>
      new AuthApi().login('ada@example.com', 'hunter22').then(
        (step) => ({ resolvedWith: step ?? 'an open session' }),
        (failure: Error) => ({ told: failure.message })
      );
    const strangeAnswers: Array<() => void> = STRANGERS.map((stranger) => () => doorAnswers(stranger));
    strangeAnswers.push(() => mockFetch({ notJson: true }));
    const told: string[] = [];
    for (let nth = 0; nth < strangeAnswers.length; nth++) {
      strangeAnswers[nth]();
      const outcome = await signIn();
      expect([nth, outcome]).toEqual([nth, { told: expect.any(String) }]);
      told.push((outcome as { told: string }).told);
    }
    // One line for every one of them: an exception's words differ from one answer to the next.
    expect(told.filter((line) => line !== told[0])).toEqual([]);
    expect(told[0].trim()).toBeTruthy();

    doorAnswers({});
    await expect(new AuthApi().login('ada@example.com', 'hunter22')).resolves.toBeUndefined();

    // An answer that is not a 200 is neither, whatever its body — a step it carries is not run, at
    // the password step or at the passkey step.
    mockFetch({ status: 502, statusText: 'Bad Gateway', body: { secondStep: STEP } });
    expect(await signIn()).toEqual({ told: expect.any(String) });
    mockFetch({ status: 502, statusText: 'Bad Gateway', body: { secondStep: STEP } });
    expect((await new AuthApi().answerPasskey(assertion)).status).toBe('restart');
  });

  it("the passkey's response and the registration post to the sign-in door itself, each under its own name, and an open session resolves done", async () => {
    const fetchMock = mockFetch({ body: {} });
    await expect(new AuthApi().answerPasskey(assertion)).resolves.toEqual({ status: 'done' });
    await expect(new AuthApi().answerAddPasskey(registration)).resolves.toEqual({ status: 'done' });
    expect(posted(fetchMock)).toEqual([
      [routes.login.path, { passkey: assertion }],
      [routes.login.path, { addPasskey: registration }],
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => [init.method, init.credentials])).toEqual([
      [routes.login.method, 'same-origin'],
      [routes.login.method, 'same-origin'],
    ]);
  });

  it("an answer carrying a new step resolves with it and the door's line; restart resolves as restart with the door's line", async () => {
    mockFetch({ body: { error: 'the door’s line for a refusal', secondStep: NEXT } });
    await expect(new AuthApi().answerPasskey(assertion)).resolves.toEqual({
      status: 'again',
      line: 'the door’s line for a refusal',
      secondStep: NEXT,
    });
    mockFetch({ body: { error: 'the door’s line for the end', restart: true } });
    await expect(new AuthApi().answerPasskey(assertion)).resolves.toEqual({
      status: 'restart',
      line: 'the door’s line for the end',
    });
  });

  it('an answer that is none of the three is the end of the step: no 200, no JSON, the limit in front of the door — each resolves as restart, never as an open session', async () => {
    const outcomes = [];
    // A step that failed on the server is answered by the framework's own page: no 200, no JSON.
    mockFetch({ status: 404, statusText: 'Not Found', notJson: true });
    outcomes.push(await new AuthApi().answerPasskey(assertion));
    mockFetch({ status: 500, statusText: 'Internal Server Error', body: { error: 'a line on a failure' } });
    outcomes.push(await new AuthApi().answerAddPasskey(registration));
    mockFetch({ status: 200, notJson: true });
    outcomes.push(await new AuthApi().answerPasskey(assertion));
    mockFetch({ status: 429 });
    outcomes.push(await new AuthApi().answerPasskey(assertion));
    // Not a 200, with a body that reads like an open session: still the end of the step.
    mockFetch({ status: 502, statusText: 'Bad Gateway', body: {} });
    outcomes.push(await new AuthApi().answerPasskey(assertion));

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['restart', 'restart', 'restart', 'restart', 'restart']);
    expect((outcomes[1] as { line: string }).line).toBe('a line on a failure');
    expect((outcomes[3] as { line: string }).line).toBe(AuthApi.TOO_MANY_ATTEMPTS);
    for (const outcome of outcomes) {
      expect((outcome as { line: string }).line).toBeTruthy();
    }
  });

  it("a 200 that carries the door's line and nothing beside it — no step, no restart — is the end of the step with that line, never an open session", async () => {
    doorAnswers({ error: 'the door’s line, alone' });
    await expect(new AuthApi().answerPasskey(assertion)).resolves.toEqual({
      status: 'restart',
      line: 'the door’s line, alone',
    });
    await expect(new AuthApi().answerAddPasskey(registration)).resolves.toEqual({
      status: 'restart',
      line: 'the door’s line, alone',
    });
  });

  it("a 200 in no shape the door sends is the end of the step — nothing, a list, text, a step of a kind the page cannot run, an answer with something else in it: each resolves as restart, and only the door's own empty answer as an open session", async () => {
    for (const stranger of STRANGERS) {
      doorAnswers(stranger);
      expect([stranger, await new AuthApi().answerPasskey(assertion)]).toEqual([
        stranger,
        { status: 'restart', line: AuthApi.STEP_OVER },
      ]);
    }

    doorAnswers({});
    await expect(new AuthApi().answerPasskey(assertion)).resolves.toEqual({ status: 'done' });
  });
});

describe("AuthApi — a refusal's own line is what the form is told", () => {
  it("sign-up: a refused answer's line, whatever its status", async () => {
    mockFetch({ status: 400, statusText: 'Bad Request', body: { error: 'Use at least 8 characters' } });
    await expect(new AuthApi().signup({ name: 'Ada', email: 'ada@example.com', password: 'short' })).rejects.toThrow(
      'Use at least 8 characters'
    );
  });

  it("the password reset: the route's 400 carries the server's rule — the person reads the rule, not a generic failure", async () => {
    mockFetch({ status: 400, statusText: 'Bad Request', body: { error: 'That password is too common' } });
    await expect(new AuthApi().executePasswordReset('tok', 'password1')).rejects.toThrow('That password is too common');
  });

  it('the password reset: a link no longer live reads as the route says it', async () => {
    mockFetch({ status: 400, body: { error: 'Reset token has expired' } });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(
      'Reset token has expired'
    );
  });

  it('an answer with no line in it falls back to the generic words — an empty body, or one that is no JSON at all', async () => {
    mockFetch({ status: 502, statusText: 'Bad Gateway', body: {} });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(
      'Failed to reset password'
    );
    mockFetch({ status: 502, statusText: 'Bad Gateway', notJson: true });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(
      'Failed to reset password'
    );
    mockFetch({ status: 502, statusText: 'Bad Gateway', notJson: true });
    await expect(
      new AuthApi().signup({ name: 'Ada', email: 'ada@example.com', password: 'hunter22x' })
    ).rejects.toThrow('Failed to sign up, error: Bad Gateway');
  });
});

describe('AuthApi.initiatePasswordReset', () => {
  it('posts the email and resolves on success', async () => {
    const fetchMock = mockFetch({ body: {} });
    await new AuthApi().initiatePasswordReset('ada@example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      routes.initiatePasswordReset.path,
      expect.objectContaining({
        method: routes.initiatePasswordReset.method,
        body: JSON.stringify({ email: 'ada@example.com' }),
      })
    );
  });

  it("resolves with the door's answer — the one sentence it gives for every address", async () => {
    mockFetch({ body: { message: 'If that address has an account, a reset link is on its way.' } });
    await expect(new AuthApi().initiatePasswordReset('ada@example.com')).resolves.toBe(
      'If that address has an account, a reset link is on its way.'
    );
  });

  it('throws a user-readable error on failure', async () => {
    mockFetch({ status: 500, statusText: 'Internal Server Error' });
    await expect(new AuthApi().initiatePasswordReset('ada@example.com')).rejects.toThrow(
      'Failed to send the reset email. Please try again.'
    );
  });
});

describe('AuthApi.validateResetToken', () => {
  it('resolves valid WITH the account email the reset is for (the form renders it as the identifier)', async () => {
    mockFetch({ body: { isValid: true, email: 'ada@example.com' } });
    await expect(new AuthApi().validateResetToken('tok')).resolves.toEqual({
      valid: true,
      email: 'ada@example.com',
    });
  });

  it('resolves invalid with the server message', async () => {
    mockFetch({ body: { isValid: false, message: 'Token expired' } });
    await expect(new AuthApi().validateResetToken('tok')).resolves.toEqual({
      valid: false,
      message: 'Token expired',
    });
  });

  it('falls back to a generic message when the server sends none', async () => {
    mockFetch({ body: { isValid: false } });
    await expect(new AuthApi().validateResetToken('tok')).resolves.toEqual({
      valid: false,
      message: 'Invalid or expired token',
    });
  });
});

describe('AuthApi.executePasswordReset', () => {
  it('posts the token and new password', async () => {
    const fetchMock = mockFetch({ body: {} });
    await new AuthApi().executePasswordReset('tok', 'hunter22');
    expect(fetchMock).toHaveBeenCalledWith(
      routes.executePasswordReset.path,
      expect.objectContaining({
        method: routes.executePasswordReset.method,
        body: JSON.stringify({ token: 'tok', newPassword: 'hunter22' }),
      })
    );
  });

  it('throws the generic words on a non-200 response that carries no line', async () => {
    mockFetch({ status: 400 });
    await expect(new AuthApi().executePasswordReset('tok', 'hunter22')).rejects.toThrow('Failed to reset password');
  });
});

/**
 * A 429 on the sign-in, sign-up and reset doors is a per-address limit in FRONT of the server (the
 * load balancer's rate-based ban): no body the form can read, and over HTTP/2 no status text either
 * (`statusText` is ''), so the old reading showed "Failed to log in, error: " and nothing after it.
 * The forms say what the doors' own throttles say instead.
 */
describe('AuthApi — a 429 from in front of the door reads as the throttle answer', () => {
  const TOO_MANY = 'Too many attempts. Try again in a few minutes.';

  it('sign-in', async () => {
    mockFetch({ status: 429, statusText: '' });
    await expect(new AuthApi().login('ada@example.com', 'nope')).rejects.toThrow(TOO_MANY);
  });

  it('sign-up', async () => {
    mockFetch({ status: 429, statusText: '' });
    await expect(new AuthApi().signup({ name: 'Ada', email: 'ada@example.com', password: 'hunter22' })).rejects.toThrow(
      TOO_MANY
    );
  });

  it('the password reset request', async () => {
    mockFetch({ status: 429, statusText: '' });
    await expect(new AuthApi().initiatePasswordReset('ada@example.com')).rejects.toThrow(TOO_MANY);
  });

  // The ban's answer is the load balancer's page, not the door's JSON — the reset link's two doors
  // read the status before any body, as the others do.
  it('the reset link check', async () => {
    mockFetch({ status: 429, statusText: '', notJson: true });
    await expect(new AuthApi().validateResetToken('tok')).rejects.toThrow(TOO_MANY);
  });

  it('the password reset', async () => {
    mockFetch({ status: 429, statusText: '', notJson: true });
    await expect(new AuthApi().executePasswordReset('tok', 'a fresh password')).rejects.toThrow(TOO_MANY);
  });
});
