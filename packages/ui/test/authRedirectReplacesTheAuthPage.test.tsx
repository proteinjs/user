/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * A successful sign-in and sign-up land the person in the app by REPLACING the auth page in
 * history, never by PUSHING the app on top of it.
 *
 * The class this pins down: the auth pages entered the app with `window.location.href = '/'`, a
 * full navigation that PUSHES the app's home document on top of the auth-page document. The auth
 * page then sits one back-forward entry behind home. On WebKit the left-edge back gesture, from a
 * route the app pushed after home, restores that auth-page document — the user lands back on the
 * login screen, a page a signed-in user can never be on.
 *
 * The invariant: the transition into the app REPLACES the auth-page entry (`window.location`'s
 * `replace`), so a signed-in person's history begins at home and back can never reach the auth
 * page. A full navigation is kept (the fresh load renders under the just-established session) —
 * only its history disposition changes from push to replace.
 *
 * Assertions are OUTCOMES on `window.location`: `replace('/')` was called, and `href` was never
 * assigned (an href assignment is the push this bug rests on).
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { routes } from '@proteinjs/user';
import type { InitializeSignupResponse } from '@proteinjs/user';
import { loginPage } from '../src/pages/Login';
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

/** A stand-in for `window.location` that records how the page left the auth screen. */
type LocationSpy = { replace: jest.Mock; assign: jest.Mock; hrefSets: string[]; href: string };

let container: HTMLDivElement;
let root: Root;
let realLocation: Location;
let locationSpy: LocationSpy;

function installLocationSpy() {
  const hrefSets: string[] = [];
  const spy = {
    replace: jest.fn(),
    assign: jest.fn(),
    hrefSets,
    get href() {
      return 'http://localhost/login';
    },
    set href(value: string) {
      hrefSets.push(value);
    },
  };
  Object.defineProperty(window, 'location', { configurable: true, value: spy });
  locationSpy = spy as unknown as LocationSpy;
}

beforeEach(() => {
  realLocation = window.location;
  initializeSignup.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  installLocationSpy();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  delete (global as any).fetch;
});

/** Answers every auth POST 200 with no error, so a submit runs through to the redirect. */
function mockServerAccepts() {
  (global as any).fetch = jest.fn(async () => ({ status: 200, statusText: 'OK', json: async () => ({}) }));
}

async function renderPage(Component: React.ComponentType<any>, url: string) {
  window.history.replaceState({}, '', url);
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

function fillSilently(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    nativeSetter.call(input, value);
  });
}

async function submit() {
  await act(async () => {
    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
}

describe('signing in lands in the app by replacing the login page', () => {
  it('replaces `/login` with home — never pushes home on top of it', async () => {
    mockServerAccepts();
    await renderPage(loginPage.component, '/login');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();

    // The login page left history: a signed-in person's back stack begins at home.
    expect(locationSpy.replace).toHaveBeenCalledWith('/');
    // An href assignment would keep /login one entry behind home (the bug).
    expect(locationSpy.hrefSets).toEqual([]);
  });
});

describe('signing up lands in the app by replacing the signup page', () => {
  it('replaces `/signup` with home — never pushes home on top of it', async () => {
    mockServerAccepts();
    initializeSignup.mockResolvedValue({ isReady: true, isInviteOnly: false });
    await renderPage(signupPage.component, '/signup');

    fillSilently(field('Name'), 'Ada Lovelace');
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    fillSilently(field('Confirm password'), PASSWORD);
    await submit();

    expect(locationSpy.replace).toHaveBeenCalledWith('/');
    expect(locationSpy.hrefSets).toEqual([]);
  });
});
