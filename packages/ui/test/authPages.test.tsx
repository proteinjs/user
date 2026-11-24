import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SourceRepository } from '@proteinjs/reflection';
import { loginPage } from '../src/pages/Login';
import { forgotPasswordPage } from '../src/pages/ForgotPassword';
import { passwordResetPage } from '../src/pages/PasswordReset';
import { signupPage } from '../src/pages/Signup';

function render(node: React.ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

/** The links a page renders, in the order it renders them: each one's address and words. */
function links(html: string): { href: string; words: string }[] {
  const found: { href: string; words: string }[] = [];
  const anchor = /<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
  for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
    found.push({ href: match[1], words: match[2] });
  }
  return found;
}

describe('auth pages', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it("login shows the line a product registers under the forgot-password link, opening the product's address, and no line when none is registered", () => {
    const Login = loginPage.component;
    // A product's registration, in words that are the test's own (the library carries no product's words).
    const product = { signupClosedLine: { words: 'Ask the product for an invite', href: '/ask-the-product' } };
    let registered: typeof product | undefined = product;
    jest.spyOn(SourceRepository, 'get').mockReturnValue({
      object: (type: string) => (type === '@proteinjs/user-ui/AuthPageProduct' ? registered : undefined),
    } as unknown as SourceRepository);

    const offered = links(render(<Login urlParams={{}} />));
    expect(offered.map((link) => link.href)).toEqual(['/login/forgot-password', product.signupClosedLine.href]);
    expect(offered[1].words).toBe(product.signupClosedLine.words);

    registered = undefined;
    expect(links(render(<Login urlParams={{}} />)).map((link) => link.href)).toEqual(['/login/forgot-password']);
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
