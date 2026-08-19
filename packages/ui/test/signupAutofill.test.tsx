/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * Password-manager capture semantics on the signup form, through the real page component
 * (initialization effect included — `getSignupService` is the only mock).
 *
 * The bug these tests pin down: the invite path rendered NO email field, so browser password
 * managers captured the closest text input — the NAME field — as the credential's username.
 * The stored "Brent Test" credential then autofilled the login email field, producing
 * "User name or password incorrect" against a perfectly valid password. The fix renders the
 * invite's email (returned by `initializeSignup`, previously discarded) as a read-only field
 * tagged `autocomplete="username"` — read-only rather than disabled because password managers
 * ignore disabled inputs, which would recreate the bug.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { InitializeSignupResponse } from '@proteinjs/user';
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

const INVITE_EMAIL = 'ada@example.com';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  initializeSignup.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderSignup(url: string) {
  window.history.replaceState({}, '', url);
  const Signup = signupPage.component;
  await act(async () => {
    root.render(<Signup urlParams={{}} />);
  });
}

function field(label: string): HTMLInputElement {
  const input = document.getElementById(`auth-field-${label}`);
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

describe('invited signup', () => {
  beforeEach(() => {
    initializeSignup.mockResolvedValue({
      isReady: true,
      isInviteOnly: true,
      invite: { email: INVITE_EMAIL } as InitializeSignupResponse['invite'],
    });
  });

  it('renders the invite email as a read-only username field (password-manager capture target)', async () => {
    await renderSignup('/signup?token=invite-token-1');
    expect(initializeSignup).toHaveBeenCalledWith('invite-token-1');

    const email = field('Email');
    expect(email.value).toBe(INVITE_EMAIL);
    expect(email.readOnly).toBe(true);
    expect(email.getAttribute('autocomplete')).toBe('username');
  });

  it('keeps the name field out of credential capture (autocomplete name, never username)', async () => {
    await renderSignup('/signup?token=invite-token-1');

    const name = field('Name');
    expect(name.readOnly).toBe(false);
    expect(name.getAttribute('autocomplete')).toBe('name');
  });

  it('tags both password fields new-password so managers offer to save the credential', async () => {
    await renderSignup('/signup?token=invite-token-1');

    expect(field('Password').getAttribute('autocomplete')).toBe('new-password');
    expect(field('Confirm password').getAttribute('autocomplete')).toBe('new-password');
  });
});

describe('plain signup', () => {
  beforeEach(() => {
    initializeSignup.mockResolvedValue({ isReady: true, isInviteOnly: false });
  });

  it('renders an editable email field tagged as the username', async () => {
    await renderSignup('/signup');
    expect(initializeSignup).toHaveBeenCalledWith(undefined);

    const email = field('Email');
    expect(email.readOnly).toBe(false);
    expect(email.getAttribute('autocomplete')).toBe('username');
    expect(field('Name').getAttribute('autocomplete')).toBe('name');
  });
});
