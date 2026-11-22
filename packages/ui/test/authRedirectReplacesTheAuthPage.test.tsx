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
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { SourceRepository } from '@proteinjs/reflection';
import type { Page } from '@proteinjs/ui';
import { routes, SIGN_IN_PAGE_FACTS_SCRIPT_KEY, uiRoutes, UserAuth } from '@proteinjs/user';
import type { EmailConfirmationStateResponse, InitializeSignupResponse } from '@proteinjs/user';
import { AuthenticatedPageContainer } from '../src/AuthenticatedPageContainer';
import { CONFIRM_EMAIL_WORDS, confirmEmailPage } from '../src/pages/ConfirmEmail';
import { loginPage } from '../src/pages/Login';
import { signupPage } from '../src/pages/Signup';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initializeSignup = jest.fn<Promise<InitializeSignupResponse>, [string | undefined]>();
const emailConfirmationState = jest.fn<Promise<EmailConfirmationStateResponse>, []>();

jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getSignupService: () => ({ initializeSignup, emailConfirmationState }),
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
  emailConfirmationState.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  installLocationSpy();
  // The page says sign-up is open (user-server SignInPageFactsScript): the sign-up form renders at once.
  (globalThis as any).proteinjs = { [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { signupOpen: true } };
  // No product registered (the suites load src, never the reflection graph): the sign-up form asks for the
  // product's sentence, and the graph's lookup answers none; every other lookup is the repository's own.
  const repository = SourceRepository.get();
  const lookup = repository.object.bind(repository);
  jest
    .spyOn(repository, 'object')
    .mockImplementation(((type: string) =>
      type === '@proteinjs/user-ui/AuthPageProduct' ? undefined : lookup(type)) as typeof repository.object);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  delete (global as any).fetch;
  delete (globalThis as any).proteinjs;
  jest.restoreAllMocks();
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
    await renderPage(signupPage.component, '/signup');

    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();

    expect(locationSpy.replace).toHaveBeenCalledWith('/');
    expect(locationSpy.hrefSets).toEqual([]);
  });
});

describe('a signed-in person never sees the log-in or sign-up page', () => {
  /** Where the router is after the page rendered, and how it got there. */
  let arrived: { pathname: string; how: string } | undefined;

  function HomeProbe() {
    arrived = { pathname: useLocation().pathname, how: useNavigationType() };
    return null;
  }

  async function open(Component: React.ComponentType<any>, url: string) {
    arrived = undefined;
    window.history.replaceState({}, '', url);
    await act(async () => {
      root.render(
        // Keyed by the address: each page opens in a router of its own, never one left at Home by the last.
        <MemoryRouter key={url} initialEntries={[url]}>
          <Routes>
            <Route path={url} element={<Component urlParams={{}} />} />
            <Route path='/' element={<HomeProbe />} />
          </Routes>
        </MemoryRouter>
      );
    });
  }

  it('a signed-in person who opens Log in, or Sign up without an invite, is replaced to Home and no form renders', async () => {
    jest.spyOn(UserAuth, 'isLoggedIn').mockReturnValue(true);
    const formsSeen: Element[] = [];
    const watcher = new MutationObserver(() => formsSeen.push(...Array.from(container.querySelectorAll('form'))));
    watcher.observe(container, { childList: true, subtree: true });

    for (const [page, url] of [
      [loginPage, '/login'],
      [signupPage, '/signup'],
    ] as const) {
      await open(page.component, url);
      expect(arrived).toEqual({ pathname: '/', how: 'REPLACE' });
    }

    watcher.disconnect();
    expect(formsSeen).toEqual([]);
    expect(locationSpy.hrefSets).toEqual([]);
    expect(initializeSignup).not.toHaveBeenCalled();
  });
});

describe('a session that waits for its email confirmation', () => {
  const WORDS = CONFIRM_EMAIL_WORDS;
  const CONFIRMATION = `/${uiRoutes.account.verifyEmail}`;

  /** What the server wrote into a waiting session's page (user-server SignInPageFactsScript). */
  function pageSaysTheSessionWaits() {
    (globalThis as any).proteinjs = {
      [SIGN_IN_PAGE_FACTS_SCRIPT_KEY]: { signupOpen: true, awaitingEmailConfirmation: { sentTo: EMAIL } },
    };
  }

  async function openTheWaitingScreen() {
    pageSaysTheSessionWaits();
    await renderPage(confirmEmailPage.component, CONFIRMATION);
    expect(container.querySelector('h1')?.textContent).toBe(WORDS.title);
  }

  async function tapTheLine(words: string) {
    const line = Array.from(container.querySelectorAll('a')).find((anchor) => anchor.textContent === words);
    expect(line).toBeDefined();
    await act(async () => {
      line!.click();
    });
  }

  it("opening any other page, one open to everyone included, is replaced to the confirmation's address before anything of that page renders", async () => {
    pageSaysTheSessionWaits();
    let arrived: { pathname: string; how: string } | undefined;
    const ConfirmationProbe = () => {
      arrived = { pathname: useLocation().pathname, how: useNavigationType() };
      return null;
    };
    let rendered = 0;
    const pageAt = (path: string, auth: Page['auth']): Page => ({
      name: path,
      path,
      auth,
      component: () => {
        rendered++;
        return null;
      },
    });

    const pages: Array<[string, Page['auth']]> = [
      ['settings', { allUsers: true }],
      ['login', { public: true }],
    ];
    for (const [path, auth] of pages) {
      arrived = undefined;
      await act(async () => {
        root.render(
          <MemoryRouter key={path} initialEntries={[`/${path}`]}>
            <Routes>
              <Route path={`/${path}`} element={<AuthenticatedPageContainer page={pageAt(path, auth)} />} />
              <Route path={CONFIRMATION} element={<ConfirmationProbe />} />
            </Routes>
          </MemoryRouter>
        );
      });
      expect(arrived).toEqual({ pathname: CONFIRMATION, how: 'REPLACE' });
    }
    expect(rendered).toBe(0);
  });

  it('from the waiting screen Log out loads Log in anew and Use a different email loads Sign up anew', async () => {
    mockServerAccepts();
    await openTheWaitingScreen();

    await tapTheLine(WORDS.logOut);

    // The session is ended first, then the destination is loaded anew: never a move inside the page.
    expect((global as any).fetch).toHaveBeenCalledWith(
      routes.logout.path,
      expect.objectContaining({ method: routes.logout.method })
    );
    expect(locationSpy.replace.mock.calls).toEqual([[`/${uiRoutes.auth.login}`]]);

    await act(async () => root.unmount());
    root = createRoot(container);
    locationSpy.replace.mockClear();
    (global as any).fetch.mockClear();
    await openTheWaitingScreen();

    await tapTheLine(WORDS.differentEmail);

    expect((global as any).fetch).toHaveBeenCalledWith(
      routes.logout.path,
      expect.objectContaining({ method: routes.logout.method })
    );
    expect(locationSpy.replace.mock.calls).toEqual([[`/${uiRoutes.auth.signup}`]]);
    expect(locationSpy.hrefSets).toEqual([]);
  });

  it('brought back to the front, the waiting screen asks once whether its account still waits, and loads the app anew once it was confirmed somewhere else', async () => {
    await openTheWaitingScreen();
    // At rest it asks nothing: no timer.
    expect(emailConfirmationState).not.toHaveBeenCalled();

    const broughtToTheFront = async () => {
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
    };

    emailConfirmationState.mockResolvedValueOnce({ state: 'waiting' });
    await broughtToTheFront();
    expect(emailConfirmationState).toHaveBeenCalledTimes(1);
    expect(locationSpy.replace).not.toHaveBeenCalled();

    emailConfirmationState.mockResolvedValueOnce({ state: 'confirmed' });
    await broughtToTheFront();
    expect(emailConfirmationState).toHaveBeenCalledTimes(2);
    expect(locationSpy.replace.mock.calls).toEqual([['/']]);
  });
});
