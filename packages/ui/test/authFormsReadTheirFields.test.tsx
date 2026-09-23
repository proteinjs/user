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
import { routes } from '@proteinjs/user';
import type { InitializeSignupResponse } from '@proteinjs/user';
import { loginPage } from '../src/pages/Login';
import { forgotPasswordPage } from '../src/pages/ForgotPassword';
import { passwordResetPage } from '../src/pages/PasswordReset';
import { signupPage } from '../src/pages/Signup';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initializeSignup = jest.fn<Promise<InitializeSignupResponse>, [string | undefined]>();

jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getSignupService: () => ({ initializeSignup }),
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (global as any).fetch;
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
  await act(async () => {
    root.render(<Component urlParams={{}} />);
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
  it('an autofill that fires no event reaches the server with the values', async () => {
    mockServer();
    initializeSignup.mockResolvedValue({ isReady: true, isInviteOnly: false });
    await renderPage(signupPage.component, '/signup');

    fillSilently(field('Name'), 'Ada Lovelace');
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    fillSilently(field('Confirm password'), PASSWORD);
    await submit();

    expect(posts).toEqual([
      { path: routes.signup.path, body: { name: 'Ada Lovelace', email: EMAIL, password: PASSWORD } },
    ]);
  });

  it('a blank submit never leaves the page: each empty field is marked', async () => {
    mockServer();
    initializeSignup.mockResolvedValue({ isReady: true, isInviteOnly: false });
    await renderPage(signupPage.component, '/signup');

    await submit();

    expect(posts).toEqual([]);
    expect(fieldError(field('Name'))).toBe('Enter your name');
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

describe('the package surface', () => {
  it('exports the form reader, so a consumer page reads its own form the same way', async () => {
    const surface = await import('../index');
    expect(typeof surface.AuthFormFields.read).toBe('function');
    expect(typeof surface.AuthFormFields.focusFirstInvalid).toBe('function');
  });
});
