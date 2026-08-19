/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * Password-manager capture semantics on the password-reset form, through the real page
 * component (token-validation effect included — global `fetch` is the only mock).
 *
 * The bug these tests pin down: the reset form rendered only the two password fields — no
 * identifier at all — so password managers had nothing to associate the updated password
 * with. The stored credential kept its OLD password while the account moved to the new one.
 * The fix renders the account email (returned by token validation; the server knows it from
 * the token's user row) as a read-only field tagged `autocomplete="username"` — read-only
 * rather than disabled because password managers ignore disabled inputs.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { passwordResetPage } from '../src/pages/PasswordReset';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT_EMAIL = 'ada@example.com';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (global as any).fetch;
});

function mockValidateResponse(body: unknown) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    json: async () => body,
  });
}

async function renderPasswordReset(url: string) {
  window.history.replaceState({}, '', url);
  const PasswordReset = passwordResetPage.component;
  await act(async () => {
    root.render(<PasswordReset urlParams={{}} />);
  });
}

function field(label: string): HTMLInputElement {
  const input = document.getElementById(`auth-field-${label}`);
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

describe('password reset form', () => {
  it('renders the account email as a read-only username field (password-manager capture target)', async () => {
    mockValidateResponse({ isValid: true, email: ACCOUNT_EMAIL });
    await renderPasswordReset('/login/reset-password?token=reset-token-1');

    const email = field('Email');
    expect(email.value).toBe(ACCOUNT_EMAIL);
    expect(email.readOnly).toBe(true);
    expect(email.getAttribute('autocomplete')).toBe('username');
  });

  it('tags both password fields new-password so managers offer to update the credential', async () => {
    mockValidateResponse({ isValid: true, email: ACCOUNT_EMAIL });
    await renderPasswordReset('/login/reset-password?token=reset-token-1');

    expect(field('New password').getAttribute('autocomplete')).toBe('new-password');
    expect(field('Confirm new password').getAttribute('autocomplete')).toBe('new-password');
  });

  it('an invalid token renders the invalid-link state — no form, no email field', async () => {
    mockValidateResponse({ isValid: false, message: 'Token has expired' });
    await renderPasswordReset('/login/reset-password?token=dead-token');

    expect(document.body.textContent).toContain('This reset link is invalid');
    expect(document.getElementById('auth-field-Email')).toBeNull();
    expect(document.getElementById('auth-field-New password')).toBeNull();
  });
});
