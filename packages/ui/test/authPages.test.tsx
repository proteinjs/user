/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * The page's own address matters to the sign-up page (an invite link carries `?token=`), so the pages
 * render against a document whose address a case sets.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { SourceRepository } from '@proteinjs/reflection';
import { SIGN_IN_PAGE_FACTS_SCRIPT_KEY, SIGNUP_CLOSED_SENTENCE, uiRoutes } from '@proteinjs/user';
import type { AuthPageProduct } from '../src/auth/AuthPageProduct';
import { CONFIRM_EMAIL_WORDS, confirmEmailPage } from '../src/pages/ConfirmEmail';
import { loginPage } from '../src/pages/Login';
import { forgotPasswordPage } from '../src/pages/ForgotPassword';
import { passwordResetPage } from '../src/pages/PasswordReset';
import { signupPage } from '../src/pages/Signup';

function render(node: React.ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

/** What the server wrote into the page at load: whether sign-up is open (user-server SignInPageFactsScript). */
function pageSays(signupOpen: boolean) {
  (globalThis as any).proteinjs = { [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { signupOpen } };
}

/** A product's registration, in words that are the test's own (the library carries no product's words). */
const PRODUCT: AuthPageProduct = {
  signupClosedLine: { words: 'New here? Ask the product', href: '/ask-the-product' },
  signupClosedSentence: 'This product is closed for now.',
  signupAgreementSentence: () => <span data-product-agreement=''>By signing up you accept the product.</span>,
};

let registered: AuthPageProduct | undefined;

beforeEach(() => {
  registered = undefined;
  jest.spyOn(SourceRepository, 'get').mockReturnValue({
    object: (type: string) => (type === '@proteinjs/user-ui/AuthPageProduct' ? registered : undefined),
    objects: () => [],
  } as unknown as SourceRepository);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (globalThis as any).proteinjs;
});

/** The addresses of the links a page renders. */
function linkTargets(html: string): string[] {
  const targets: string[] = [];
  const anchor = /<a [^>]*href="([^"]*)"/g;
  for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
    targets.push(match[1]);
  }
  return targets;
}

describe('auth pages', () => {
  it('login renders email + password fields, the submit action, and the forgot-password link', () => {
    const Login = loginPage.component;
    const html = render(<Login urlParams={{}} />);
    expect(html).toContain('Email');
    expect(html).toContain('Password');
    expect(html).toContain('Log in');
    expect(html).toContain('href="/login/forgot-password"');
    // Real submit semantics: Enter submits the form.
    expect(html).toContain('type="submit"');
    // Mobile keyboards + autofill: proper autocomplete tokens (HTML attribute names are
    // case-insensitive; SSR emits the camelCase form). The identifier field is tagged
    // `username` — the token password managers fill from the stored credential — while
    // type="email" keeps the email keyboard.
    expect(html.toLowerCase()).toContain('autocomplete="username"');
    expect(html.toLowerCase()).toContain('type="email"');
    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
  });

  it("the log-in page shows the open line when the page says open, the product's closed line when closed, and no line when closed with none registered", () => {
    const Login = loginPage.component;
    registered = PRODUCT;

    pageSays(true);
    let html = render(<Login urlParams={{}} />);
    expect(linkTargets(html)).toEqual(['/login/forgot-password', '/signup']);

    pageSays(false);
    html = render(<Login urlParams={{}} />);
    expect(linkTargets(html)).toEqual(['/login/forgot-password', PRODUCT.signupClosedLine.href]);
    expect(html).toContain(PRODUCT.signupClosedLine.words);

    registered = undefined;
    html = render(<Login urlParams={{}} />);
    expect(linkTargets(html)).toEqual(['/login/forgot-password']);
  });

  it('forgot password renders the email field, the send action, and a way back to login', () => {
    const ForgotPassword = forgotPasswordPage.component;
    const html = render(<ForgotPassword urlParams={{}} />);
    expect(html).toContain('Reset your password');
    expect(html).toContain('Send reset link');
    expect(html).toContain('href="/login"');
    // Same identifier token as login, so the password manager fills the stored username here.
    expect(html.toLowerCase()).toContain('autocomplete="username"');
  });

  it('password reset without a token renders the invalid-link state, never the form', () => {
    const PasswordReset = passwordResetPage.component;
    const html = render(<PasswordReset urlParams={{}} />);
    expect(html).toContain('This reset link is invalid');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('New password');
  });

  it('signup with an invite link renders its loading state before initialization resolves (no form flash)', () => {
    window.history.replaceState({}, '', '/signup?token=invite-token-1');
    pageSays(true);
    const Signup = signupPage.component;
    const html = render(<Signup urlParams={{}} />);
    expect(html).toContain('Create your account');
    expect(html).not.toContain('type="submit"');
  });

  it("without an invite the sign-up page renders at once: the form when open, the closed panel with the product's sentence when closed", () => {
    window.history.replaceState({}, '', '/signup');
    const Signup = signupPage.component;

    pageSays(true);
    let html = render(<Signup urlParams={{}} />);
    expect(html).toContain('type="submit"');
    expect(html).toContain('name="email"');

    pageSays(false);
    registered = PRODUCT;
    html = render(<Signup urlParams={{}} />);
    expect(html).toContain(PRODUCT.signupClosedSentence);
    expect(linkTargets(html)).toEqual(['/login']);
    expect(html).not.toContain('type="submit"');

    registered = undefined;
    html = render(<Signup urlParams={{}} />);
    expect(html).toContain(SIGNUP_CLOSED_SENTENCE);
  });

  it("without an invite the sign-up page shows two fields, the product's sentence above Sign up, and Have an account? Log in under it", () => {
    window.history.replaceState({}, '', '/signup');
    pageSays(true);
    registered = PRODUCT;
    const Signup = signupPage.component;

    let html = render(<Signup urlParams={{}} />);
    const fields: string[] = [];
    const input = /<input [^>]*name="([^"]*)"/g;
    for (let match = input.exec(html); match; match = input.exec(html)) {
      // The fields a person reaches: the hidden field for the product's check is out of the tab order.
      if (!/tabindex="-1"/.test(html.slice(match.index, html.indexOf('>', match.index)))) {
        fields.push(match[1]);
      }
    }
    expect(fields).toEqual(['email', 'password']);
    const sentence = html.indexOf('data-product-agreement');
    const button = html.indexOf('type="submit"');
    const logIn = html.indexOf('href="/login"');
    expect(sentence).toBeGreaterThan(-1);
    expect(sentence).toBeLessThan(button);
    expect(logIn).toBeGreaterThan(button);
    expect(linkTargets(html)).toEqual(['/login']);

    registered = undefined;
    html = render(<Signup urlParams={{}} />);
    expect(html).not.toContain('data-product-agreement');
    expect(html).toContain('type="submit"');
  });

  it('a page that carries no fact is read as closed', () => {
    window.history.replaceState({}, '', '/signup');
    registered = PRODUCT;
    const Login = loginPage.component;
    const Signup = signupPage.component;
    const pages: Array<{ proteinjs?: unknown }> = [
      {},
      { proteinjs: {} },
      { proteinjs: { [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: {} } },
      { proteinjs: { [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { somethingElse: true } } },
    ];
    for (const page of pages) {
      if ('proteinjs' in page) {
        (globalThis as any).proteinjs = page.proteinjs;
      } else {
        delete (globalThis as any).proteinjs;
      }
      expect(linkTargets(render(<Login urlParams={{}} />))).toEqual([
        '/login/forgot-password',
        PRODUCT.signupClosedLine.href,
      ]);
      const html = render(<Signup urlParams={{}} />);
      expect(html).toContain(PRODUCT.signupClosedSentence);
      expect(html).not.toContain('type="submit"');
    }
  });

  it('the confirmation page shows the waiting screen to a waiting session: the address, Resend, Use a different email, Log out; with nobody signed in and no token it goes to Log in', async () => {
    const address = `/${uiRoutes.account.verifyEmail}`;
    window.history.replaceState({}, '', address);
    const ConfirmEmail = confirmEmailPage.component;

    // What the server wrote into a waiting session's page (user-server SignInPageFactsScript).
    (globalThis as any).proteinjs = {
      [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: {
        signupOpen: true,
        awaitingEmailConfirmation: { sentTo: 'dana@whitfield.studio' },
      },
    };
    const html = render(<ConfirmEmail urlParams={{}} />);
    const words = CONFIRM_EMAIL_WORDS;
    const read = html.replace(/<[^>]+>/g, '');
    expect(read).toContain(words.title);
    expect(read).toContain(`${words.sentTo} dana@whitfield.studio`);
    const resend = html.indexOf(`>${words.resend}<`);
    const differentEmail = html.indexOf(`>${words.differentEmail}<`);
    const logOut = html.indexOf(`>${words.logOut}<`);
    expect(resend).toBeGreaterThan(-1);
    expect(differentEmail).toBeGreaterThan(resend);
    expect(logOut).toBeGreaterThan(differentEmail);
    // The two quiet lines say where each leads; the screen holds no field and nothing else to tap.
    expect(linkTargets(html)).toEqual([`/${uiRoutes.auth.signup}`, `/${uiRoutes.auth.login}`]);
    expect(html).not.toContain('<input');
    // At rest the answer's line is there and says nothing.
    expect(html.match(/<[^>]+role="status"[^>]*>([^<]*)</)?.[1]).toBe('');

    // Nobody signed in, no fact of a waiting session, no token: Log in takes the page's place.
    pageSays(true);
    let arrived: { pathname: string; state: unknown; how: string } | undefined;
    const LoginProbe = () => {
      const location = useLocation();
      arrived = { pathname: location.pathname, state: location.state, how: useNavigationType() };
      return null;
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={[address]}>
            <Routes>
              <Route path={address} element={<ConfirmEmail urlParams={{}} />} />
              <Route path={`/${uiRoutes.auth.login}`} element={<LoginProbe />} />
            </Routes>
          </MemoryRouter>
        );
      });
      expect(arrived).toEqual({ pathname: `/${uiRoutes.auth.login}`, state: null, how: 'REPLACE' });
      expect(container.textContent).toBe('');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
