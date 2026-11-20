import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SourceRepository } from '@proteinjs/reflection';
import { SIGN_IN_PAGE_FACTS_SCRIPT_KEY } from '@proteinjs/user';
import type { AuthPageProduct } from '../src/auth/AuthPageProduct';
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
};

let registered: AuthPageProduct | undefined;

beforeEach(() => {
  registered = undefined;
  jest
    .spyOn(SourceRepository, 'get')
    .mockReturnValue({
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

  it('the log-in page shows the open line when the page says open, the product\'s closed line when closed, and no line when closed with none registered', () => {
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

  it('signup renders its loading state before initialization resolves (no form flash)', () => {
    const Signup = signupPage.component;
    const html = render(<Signup urlParams={{}} />);
    expect(html).toContain('Create your account');
    expect(html).not.toContain('type="submit"');
  });
});
