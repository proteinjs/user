import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { loginPage } from '../src/pages/Login';

/**
 * The login page's message seat: a page that sends a person to log in may hand the login page one
 * plain sentence in the router's location state (`{ message }`) — e.g. why they were just signed
 * out. It renders as one inset above the fields, announced politely; with no message (or anything
 * that is not a sentence) the page is exactly the plain login form.
 */
function renderLogin(state?: unknown) {
  const Login = loginPage.component;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
      <Login urlParams={{}} />
    </MemoryRouter>
  );
}

const SENTENCE = 'You were signed out. Sign in whenever you are ready.';

describe('the login page message seat', () => {
  it('renders the sentence the arriving navigation carried, once, above the fields', () => {
    const html = renderLogin({ message: SENTENCE });
    const seat = html.match(/<[^>]+role="status"[^>]*>([^<]*)</);
    expect(seat?.[1]).toBe(SENTENCE);
    expect(html.split(SENTENCE)).toHaveLength(2);
    expect(html.indexOf(SENTENCE)).toBeLessThan(html.indexOf('Email'));
    // The form is untouched beside it.
    expect(html).toContain('type="submit"');
    expect(html).toContain('href="/login/forgot-password"');
  });

  it('with no message the page is the plain login form — no seat at all', () => {
    for (const state of [undefined, null, {}, { message: '' }, { message: 42 }]) {
      const html = renderLogin(state);
      expect(html).not.toContain('role="status"');
      expect(html).toContain('Log in');
    }
  });
});
