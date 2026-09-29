/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * A successful sign-in lands where the login URL's `?returnTo=` asked — when that is a same-origin
 * path — and on home otherwise.
 *
 * The class this pins down: a page that needs a session sent the person to `/login?returnTo=<its
 * own address>`, and the login page landed every sign-in on `/`. The person signed in to open one
 * thing and had to find it again.
 *
 * The invariant has two halves and both are asserted as OUTCOMES on `window.location`: the
 * navigation after a sign-in is `replace(<returnTo>)` for a same-origin path, and `replace('/')`
 * for anything that would leave the origin (an absolute URL, a protocol-relative `//host`, a
 * `javascript:` value) or for no return-to at all. `href` is never assigned (the push the history
 * suite forbids).
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { loginPage } from '../src/pages/Login';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';
const RETURN_TO = '/document?id=7f3c1c2a-1c0e-4d3b-9a5e-2b6c7d8e9f01&invite=b2f0c4d6e8a1';

/** A stand-in for `window.location` that records where the page went after the sign-in. */
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  installLocationSpy();
  // The sign-in door accepts, so a submit runs through to the landing.
  (global as any).fetch = jest.fn(async () => ({ status: 200, statusText: 'OK', json: async () => ({}) }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  delete (global as any).fetch;
});

/** Renders the login page at `url` — the query string is what the page reads its return-to from. */
async function renderLogin(url: string) {
  const Login = loginPage.component;
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Login urlParams={{}} />
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

async function signIn() {
  fillSilently(field('Email'), EMAIL);
  fillSilently(field('Password'), PASSWORD);
  await act(async () => {
    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
}

/** The one navigation the sign-in made, as an outcome: what `replace` received. */
function landing(): string {
  expect(locationSpy.replace).toHaveBeenCalledTimes(1);
  expect(locationSpy.hrefSets).toEqual([]);
  return locationSpy.replace.mock.calls[0][0];
}

describe('a sign-in honours the login URL’s returnTo', () => {
  it('lands on the same-origin path the URL asked for, query and all', async () => {
    await renderLogin(`/login?returnTo=${encodeURIComponent(RETURN_TO)}`);
    await signIn();
    expect(landing()).toBe(RETURN_TO);
  });

  it('survives the sign-in’s own round trip: a refused attempt, then the sign-in, still lands there', async () => {
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, statusText: 'OK', json: async () => ({ error: 'Wrong password' }) })
      .mockResolvedValueOnce({ status: 200, statusText: 'OK', json: async () => ({}) });
    await renderLogin(`/login?returnTo=${encodeURIComponent(RETURN_TO)}`);
    await signIn();
    expect(container.textContent).toContain('Wrong password');
    expect(locationSpy.replace).not.toHaveBeenCalled();
    await signIn();
    expect(landing()).toBe(RETURN_TO);
  });

  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a javascript: value', 'javascript:alert(document.cookie)'],
  ])('refuses %s — it lands on home', async (_case, value) => {
    await renderLogin(`/login?returnTo=${encodeURIComponent(value)}`);
    await signIn();
    expect(landing()).toBe('/');
  });

  it('with no returnTo lands on home', async () => {
    await renderLogin('/login');
    await signIn();
    expect(landing()).toBe('/');
  });
});
