/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * What a person sees after asking for a reset link: the door's own answer — the one sentence it
 * gives for every address, with an account or without, throttled or not — never a claim that a
 * mail was sent (the page cannot know, and must not seem to).
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { forgotPasswordPage } from '../src/pages/ForgotPassword';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ONE_ANSWER = 'If that address has an account, a reset link is on its way.';

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

function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function askForALink(email: string) {
  const ForgotPassword = forgotPasswordPage.component;
  await act(async () => {
    root.render(<ForgotPassword urlParams={{}} />);
  });
  await act(async () => {
    type(document.getElementById('auth-field-Email') as HTMLInputElement, email);
  });
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('forgot password — the answer shown', () => {
  it("shows the door's one sentence, never a claim that a mail was sent", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: ONE_ANSWER }),
    });

    await askForALink('ada@example.com');

    expect(document.body.textContent).toContain(ONE_ANSWER);
    expect(document.body.textContent).not.toContain('We sent an email');
  });
});
