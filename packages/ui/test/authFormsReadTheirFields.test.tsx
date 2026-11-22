/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * The auth forms submit what their fields HOLD, however the value got there — through the real
 * page components, with global `fetch` (and the signup service) as the only mocks.
 *
 * The class these tests pin down: a password manager, the platform's autofill service or an
 * input method can write a field's value WITHOUT the `input` event React listens for. The field
 * then looks filled while a controlled component's state is still empty, so a submit that sends
 * the state posts blanks (the server answers "Email and password cannot be blank"). Worse, the
 * next re-render of a controlled field — the focus ring moving as the person taps the button is
 * enough — writes the empty state back over the filled value. The forms therefore own their
 * values in the DOM (uncontrolled fields) and read them from the form at submit; a blank submit
 * is refused in the page with the field marked, so a real form never sends a blank.
 *
 * `fillSilently` is the autofill shape: the value goes in through the native value setter (the
 * path the browser's own filler takes — it never touches React's instance-level value tracker)
 * and no event is dispatched.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { SourceRepository } from '@proteinjs/reflection';
import { routes, uiRoutes, UserAuth } from '@proteinjs/user';
import type {
  EmailConfirmationStateResponse,
  InitializeSignupResponse,
  ResendEmailVerificationResponse,
  VerifyEmailState,
} from '@proteinjs/user';
import { SIGN_IN_PAGE_FACTS_SCRIPT_KEY } from '@proteinjs/user';
import { CONFIRM_EMAIL_WORDS, confirmEmailPage } from '../src/pages/ConfirmEmail';
import { loginPage } from '../src/pages/Login';
import { forgotPasswordPage } from '../src/pages/ForgotPassword';
import { passwordResetPage } from '../src/pages/PasswordReset';
import { signupPage } from '../src/pages/Signup';
import type { AuthPageProduct } from '../src/auth/AuthPageProduct';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initializeSignup = jest.fn<Promise<InitializeSignupResponse>, [string | undefined]>();
const resendEmailVerification = jest.fn<Promise<ResendEmailVerificationResponse>, []>();
const emailConfirmationState = jest.fn<Promise<EmailConfirmationStateResponse>, []>();

jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getSignupService: () => ({ initializeSignup, resendEmailVerification, emailConfirmationState }),
}));

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';

type FetchCall = { path: string; body: any };

let container: HTMLDivElement;
let root: Root;
let posts: FetchCall[];

beforeEach(() => {
  posts = [];
  initializeSignup.mockReset();
  resendEmailVerification.mockReset();
  emailConfirmationState.mockReset();
  // The page says sign-up is open (user-server SignInPageFactsScript): the sign-up form renders at once.
  (globalThis as any).proteinjs = { [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { signupOpen: true } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (global as any).fetch;
  delete (globalThis as any).proteinjs;
  jest.restoreAllMocks();
});

/**
 * Records every POST body; answers each route the way the page needs to stay put (the login and
 * signup answers carry an error so the page never navigates away inside jsdom).
 */
function mockServer() {
  (global as any).fetch = jest.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'post') {
      posts.push({ path, body: JSON.parse(init.body ?? '{}') });
    }
    const body = path.startsWith(routes.validateResetToken.path)
      ? { isValid: true, email: EMAIL }
      : path === routes.login.path
        ? { error: 'User name or password incorrect' }
        : path === routes.signup.path
          ? { error: 'Signups are closed' }
          : {};
    return { status: 200, statusText: 'OK', json: async () => body };
  });
}

async function renderPage(Component: React.ComponentType<any>, url: string) {
  window.history.replaceState({}, '', url);
  // A page renders under the app's router (the login page reads its arrival's location state).
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Component urlParams={{}} />
      </MemoryRouter>
    );
  });
}

function field(label: string): HTMLInputElement {
  const input = document.getElementById(`auth-field-${label}`);
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

/** The autofill shape: the native value setter, and no event at all. */
function fillSilently(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    nativeSetter.call(input, value);
  });
}

/** A filler that announces its write with a bare `change` (no `input`). */
function fillWithChangeOnly(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Typing: each write followed by the `input` event a keyboard produces. */
function type(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  const button = container.querySelector('button[type="submit"]');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

async function submit() {
  await act(async () => {
    submitButton().click();
  });
}

/** The field's own error line (MUI wires it to the input through aria-describedby). */
function fieldError(input: HTMLInputElement): string | null {
  if (input.getAttribute('aria-invalid') !== 'true') {
    return null;
  }
  const describedBy = input.getAttribute('aria-describedby');
  return describedBy ? document.getElementById(describedBy)?.textContent ?? null : null;
}

describe('sign-in form', () => {
  it('an autofill that fires no event reaches the server with the values', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();

    expect(posts).toEqual([{ path: routes.login.path, body: { email: EMAIL, password: PASSWORD } }]);
  });

  it('a silent fill survives the focus moving to the button (the re-render a tap causes)', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    // The person taps into the password field, then taps the button: the field gains and then
    // loses focus, and the text field re-renders its focus ring each time.
    act(() => field('Password').focus());
    act(() => submitButton().focus());

    expect(field('Password').value).toBe(PASSWORD);
    await submit();
    expect(posts).toEqual([{ path: routes.login.path, body: { email: EMAIL, password: PASSWORD } }]);
  });

  it('a filler that fires only `change` reaches the server with the values', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    fillWithChangeOnly(field('Email'), EMAIL);
    fillWithChangeOnly(field('Password'), PASSWORD);
    await submit();

    expect(posts).toEqual([{ path: routes.login.path, body: { email: EMAIL, password: PASSWORD } }]);
  });

  it('typed values reach the server', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    type(field('Email'), EMAIL);
    type(field('Password'), PASSWORD);
    await submit();

    expect(posts).toEqual([{ path: routes.login.path, body: { email: EMAIL, password: PASSWORD } }]);
  });

  it('a blank submit never leaves the page: each empty field is marked', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('Email'))).toBe('Enter your email');
    expect(fieldError(field('Password'))).toBe('Enter your password');
    // The first marked field takes the focus, so the keyboard opens where the person must type.
    expect(document.activeElement).toBe(field('Email'));
  });

  it('a submit with only the password blank marks only the password', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    fillSilently(field('Email'), EMAIL);
    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('Email'))).toBeNull();
    expect(fieldError(field('Password'))).toBe('Enter your password');
  });

  it("editing a marked field clears that field's mark", async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    await submit();
    type(field('Email'), EMAIL);

    expect(fieldError(field('Email'))).toBeNull();
    expect(fieldError(field('Password'))).toBe('Enter your password');
  });
});

describe('forgot-password form', () => {
  it('an autofill that fires no event reaches the server with the email', async () => {
    mockServer();
    await renderPage(forgotPasswordPage.component, '/login/forgot-password');

    fillSilently(field('Email'), EMAIL);
    await submit();

    expect(posts).toEqual([{ path: routes.initiatePasswordReset.path, body: { email: EMAIL } }]);
  });

  it('a blank submit never leaves the page: the email is marked', async () => {
    mockServer();
    await renderPage(forgotPasswordPage.component, '/login/forgot-password');

    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('Email'))).toBe('Enter your email');
  });
});

describe('password-reset form', () => {
  it('an autofill that fires no event (a suggested password) reaches the server', async () => {
    mockServer();
    await renderPage(passwordResetPage.component, '/login/password-reset?token=reset-token-1');

    fillSilently(field('New password'), PASSWORD);
    fillSilently(field('Confirm new password'), PASSWORD);
    await submit();

    expect(posts).toEqual([
      { path: routes.executePasswordReset.path, body: { token: 'reset-token-1', newPassword: PASSWORD } },
    ]);
  });

  it('a blank submit never leaves the page: the new password is marked', async () => {
    mockServer();
    await renderPage(passwordResetPage.component, '/login/password-reset?token=reset-token-1');

    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('New password'))).toBe('Enter a new password');
  });

  it('a mismatched confirmation marks the confirmation', async () => {
    mockServer();
    await renderPage(passwordResetPage.component, '/login/password-reset?token=reset-token-1');

    fillSilently(field('New password'), PASSWORD);
    fillSilently(field('Confirm new password'), `${PASSWORD}!`);
    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('New password'))).toBeNull();
    expect(fieldError(field('Confirm new password'))).toBe('Passwords do not match');
  });
});

describe('signup form', () => {
  /** The product the graph's lookup answers for the sign-in pages; none unless a case registers one. */
  let product: Partial<AuthPageProduct> | undefined;

  beforeEach(() => {
    // No product registered (the suites load src, never the reflection graph): the sign-up form asks for the
    // product's sentence, and the graph's lookup answers none; every other lookup is the repository's own.
    product = undefined;
    const repository = SourceRepository.get();
    const lookup = repository.object.bind(repository);
    jest
      .spyOn(repository, 'object')
      .mockImplementation(((type: string) =>
        type === '@proteinjs/user-ui/AuthPageProduct' ? product : lookup(type)) as typeof repository.object);
  });

  it('an autofill that fires no event reaches the server with the values', async () => {
    mockServer();
    await renderPage(signupPage.component, '/signup');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();

    expect(posts).toEqual([{ path: routes.signup.path, body: { email: EMAIL, password: PASSWORD, website: '' } }]);
  });

  it("the sign-up page sends its hidden field and the product's timing token with the sign-up, asks the product for a new token after a refusal, and sends neither with an invite", async () => {
    let renewals = 0;
    product = {
      signupFormToken: () => ({
        renew: () => {
          renewals += 1;
        },
        forSubmit: async () => `timing-token-${renewals}`,
      }),
    };
    mockServer();
    await renderPage(signupPage.component, '/signup');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit(); // refused by the server
    // The hidden field as a bot fills it: the value it was given is what the server reads.
    const hidden = container.querySelector<HTMLInputElement>('form input[name="website"]');
    expect(hidden).not.toBeNull();
    fillSilently(hidden!, 'filled-by-a-bot');
    await submit();

    expect(posts).toEqual([
      {
        path: routes.signup.path,
        body: { email: EMAIL, password: PASSWORD, website: '', formToken: 'timing-token-1' },
      },
      {
        path: routes.signup.path,
        body: { email: EMAIL, password: PASSWORD, website: 'filled-by-a-bot', formToken: 'timing-token-2' },
      },
    ]);

    await act(async () => root.unmount());
    root = createRoot(container);
    initializeSignup.mockResolvedValue({
      isReady: true,
      isInviteOnly: true,
      invite: { email: EMAIL } as InitializeSignupResponse['invite'],
    });
    posts = [];
    await renderPage(signupPage.component, '/signup?token=invite-token-1');
    fillSilently(field('Name'), 'Ada');
    fillSilently(field('Password'), PASSWORD);
    fillSilently(field('Confirm password'), PASSWORD);
    await submit();

    expect(posts).toEqual([
      { path: routes.signup.path, body: { name: 'Ada', password: PASSWORD, token: 'invite-token-1' } },
    ]);
  });

  it('a blank submit never leaves the page: each empty field is marked', async () => {
    mockServer();
    await renderPage(signupPage.component, '/signup');

    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('Email'))).toBe('Enter your email');
    expect(fieldError(field('Password'))).toBe('Enter a password');
  });
});

describe('the fields own their values (what the fix rests on)', () => {
  it('a silently filled password survives the show-password toggle and reaches the server', async () => {
    mockServer();
    await renderPage(loginPage.component, '/login');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    // The reveal toggle re-renders the field with type='text': the same input, its value kept.
    await act(async () => {
      (container.querySelector('button[aria-label="Show password"]') as HTMLButtonElement).click();
    });
    expect(field('Password').type).toBe('text');
    expect(field('Password').value).toBe(PASSWORD);

    await submit();
    expect(posts).toEqual([{ path: routes.login.path, body: { email: EMAIL, password: PASSWORD } }]);
  });

  it('no field switches between controlled and uncontrolled across a refusal, typing and a submit (React warns on that)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockServer();
      await renderPage(loginPage.component, '/login');

      await submit(); // refused: both fields marked
      type(field('Email'), EMAIL); // the mark clears
      fillSilently(field('Password'), PASSWORD);
      await submit(); // sent; `busy` flips the fields disabled and back

      expect(posts).toHaveLength(1);
      const warnings = consoleError.mock.calls.map((call) => call.map(String).join(' '));
      expect(warnings.filter((warning) => /controlled/i.test(warning))).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("the email confirmation's page", () => {
  const WORDS = CONFIRM_EMAIL_WORDS;
  const TOKEN = 'c0ffee'.padEnd(64, '0');
  const LINK = `/${uiRoutes.account.verifyEmail}?token=${TOKEN}`;

  /** A stand-in for `window.location`: the address the page was opened at, and how the page left it. */
  let location: { pathname: string; search: string; replace: jest.Mock };
  let realLocation: Location;
  /** Where the router went when the page moved inside the app (never a load anew), and how. */
  let movedTo: { pathname: string; state: unknown; how: string } | undefined;

  const ElsewhereProbe = () => {
    const there = useLocation();
    movedTo = { pathname: there.pathname, state: there.state, how: useNavigationType() };
    return null;
  };

  beforeEach(() => {
    realLocation = window.location;
    movedTo = undefined;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  /**
   * Opens the page at the mail's link, under React's strict mode (which runs an effect twice): the
   * route answers `state`, every POST is recorded and answered with no error. Resolves with every
   * request the link's route was asked.
   */
  async function openTheLink(state: VerifyEmailState): Promise<string[]> {
    const asked: string[] = [];
    (global as any).fetch = jest.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith(routes.verifyEmail.path)) {
        asked.push(path);
        return { status: 200, statusText: 'OK', json: async () => ({ state }) };
      }
      if (init?.method === 'post') {
        posts.push({ path, body: JSON.parse(init.body ?? '{}') });
      }
      return { status: 200, statusText: 'OK', json: async () => ({}) };
    });
    location = { pathname: `/${uiRoutes.account.verifyEmail}`, search: `?token=${TOKEN}`, replace: jest.fn() };
    Object.defineProperty(window, 'location', { configurable: true, value: location });
    const ConfirmEmail = confirmEmailPage.component;
    await act(async () => {
      root.render(
        <React.StrictMode>
          <MemoryRouter initialEntries={[LINK]}>
            <Routes>
              <Route path={`/${uiRoutes.account.verifyEmail}`} element={<ConfirmEmail urlParams={{}} />} />
              <Route path='*' element={<ElsewhereProbe />} />
            </Routes>
          </MemoryRouter>
        </React.StrictMode>
      );
    });
    // The route's answer, and what the page asks after it, arrive after the first paint.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return asked;
  }

  /** The line under the button, as a person reads it (its room's unseen sentences are not it). */
  function answerLine(): string | null {
    return container.querySelector('[role="status"], [role="alert"]')?.textContent ?? null;
  }

  async function tapResend() {
    await act(async () => {
      (container.querySelector('button[type="button"]') as HTMLButtonElement).click();
    });
  }

  it('with a token, the page asks once and follows the answer: confirmed loads the root; log in first shows the log-in form, and a log-in reloads the same address', async () => {
    let asked = await openTheLink('confirmed');

    expect(asked).toEqual([`${routes.verifyEmail.path}?token=${TOKEN}`]);
    expect(location.replace.mock.calls).toEqual([['/']]);
    // Nothing is said, and nothing but the ground painted.
    expect(container.textContent).toBe('');

    await act(async () => root.unmount());
    root = createRoot(container);
    asked = await openTheLink('logInFirst');

    expect(asked).toHaveLength(1);
    expect(location.replace).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toBe(WORDS.logInFirstTitle);
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();
    expect(posts).toEqual([{ path: routes.login.path, body: { email: EMAIL, password: PASSWORD } }]);
    // The same address, link and all, loaded anew under the session the log-in made.
    expect(location.replace.mock.calls).toEqual([[LINK]]);
  });

  it("a link that no longer works opens the waiting screen saying so, and Resend's answer takes that line's place: it stays while Resend is in flight, then sent, sent a moment ago, could not be sent; confirmed elsewhere loads the root", async () => {
    (globalThis as any).proteinjs = {
      [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { signupOpen: true, awaitingEmailConfirmation: { sentTo: EMAIL } },
    };
    emailConfirmationState.mockResolvedValue({ state: 'waiting' });
    await openTheLink('invalid');

    // The page's fact can be older than a confirmation made a moment ago: asked once before saying so.
    expect(emailConfirmationState).toHaveBeenCalledTimes(1);
    expect(container.querySelector('h1')?.textContent).toBe(WORDS.title);
    expect(answerLine()).toBe(WORDS.answers.linkGone.words);

    let answerTheResend!: (response: ResendEmailVerificationResponse) => void;
    resendEmailVerification.mockReturnValueOnce(new Promise((resolve) => (answerTheResend = resolve)));
    await tapResend();
    expect(answerLine()).toBe(WORDS.answers.linkGone.words);
    await act(async () => answerTheResend({ sent: true }));
    expect(answerLine()).toBe(WORDS.answers.sent.words);

    resendEmailVerification.mockResolvedValueOnce({ sent: false, whyNot: 'tooSoon' });
    await tapResend();
    expect(answerLine()).toBe(WORDS.answers.tooSoon.words);

    resendEmailVerification.mockResolvedValueOnce({ sent: false, whyNot: 'notSent' });
    await tapResend();
    expect(answerLine()).toBe(WORDS.answers.notSent.words);

    resendEmailVerification.mockResolvedValueOnce({ sent: true });
    await tapResend();
    resendEmailVerification.mockRejectedValueOnce(new Error('The call could not be made'));
    await tapResend();
    expect(answerLine()).toBe(WORDS.answers.notSent.words);

    expect(location.replace).not.toHaveBeenCalled();
    resendEmailVerification.mockResolvedValueOnce({ sent: false, whyNot: 'alreadyConfirmed' });
    await tapResend();
    expect(location.replace.mock.calls).toEqual([['/']]);

    // A question that cannot be answered leaves the page's fact standing: the same screen, the same line.
    await act(async () => root.unmount());
    root = createRoot(container);
    emailConfirmationState.mockRejectedValue(new Error('The call could not be made'));
    await openTheLink('expired');
    expect(container.querySelector('h1')?.textContent).toBe(WORDS.title);
    expect(answerLine()).toBe(WORDS.answers.linkGone.words);
  });

  it('a Resend that does not go through first asks whether this session still waits: ended somewhere else, Log in is loaded anew and nothing is said; when that cannot be answered either, the line says the mail did not go through', async () => {
    (globalThis as any).proteinjs = {
      [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { signupOpen: true, awaitingEmailConfirmation: { sentTo: EMAIL } },
    };
    emailConfirmationState.mockResolvedValue({ state: 'waiting' });
    await openTheLink('invalid');
    expect(container.querySelector('h1')?.textContent).toBe(WORDS.title);

    // Neither call can be made: the screen stays, and says what it knows.
    resendEmailVerification.mockRejectedValueOnce(new Error('The call could not be made'));
    emailConfirmationState.mockRejectedValueOnce(new Error('The call could not be made'));
    await tapResend();
    expect(answerLine()).toBe(WORDS.answers.notSent.words);
    expect(location.replace).not.toHaveBeenCalled();

    // The session has ended somewhere else since the screen was painted (the account started over by
    // another sign-up, a log-out in another tab, its age): a visitor is refused the re-send, and asked
    // whether it still waits is answered nobody.
    resendEmailVerification.mockRejectedValueOnce(new Error('User not authorized'));
    emailConfirmationState.mockResolvedValueOnce({ state: 'nobody' });
    await tapResend();
    expect(location.replace.mock.calls).toEqual([[`/${uiRoutes.auth.login}`]]);
    // The line that was there stays until the page is gone: nothing new is said on the way out.
    expect(answerLine()).toBe(WORDS.answers.notSent.words);
  });

  it('a link that no longer works, opened with nobody signed in, goes to Log in with the sentence for its message place; opened by a signed-in person, it goes to the root and says nothing', async () => {
    await openTheLink('invalid');

    expect(movedTo).toEqual({
      pathname: `/${uiRoutes.auth.login}`,
      state: { message: WORDS.linkGoneLogIn },
      how: 'REPLACE',
    });
    // No session waits here, so nothing is asked about one; and nothing is loaded anew.
    expect(emailConfirmationState).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(container);
    jest.spyOn(UserAuth, 'isLoggedIn').mockReturnValue(true);
    await openTheLink('invalid');

    expect(movedTo).toEqual({ pathname: '/', state: null, how: 'REPLACE' });
    expect(location.replace).not.toHaveBeenCalled();
  });
});

describe('the package surface', () => {
  it('exports the form reader, so a consumer page reads its own form the same way', async () => {
    const surface = await import('../index');
    expect(typeof surface.AuthFormFields.read).toBe('function');
    expect(typeof surface.AuthFormFields.focusFirstInvalid).toBe('function');
  });
});
