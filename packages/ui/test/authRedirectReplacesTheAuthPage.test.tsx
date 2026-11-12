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
 *
 * THE PASSKEY STEP rides the same page and the same landing (the last describe): for an account
 * that must use a passkey the door answers the password with a step, and the page changes in
 * place — nobody is in the app until the step passes. The device's sheet is a stand-in here
 * (`PasskeyCeremonies`, stubbed at the package boundary): no browser authenticator runs. A step's
 * request that never reaches the door is a line above the same button; and a person who goes back
 * to the password form while a tap is still out has the form at once, whatever that tap comes to —
 * also when they have signed in again by then and a new tap is out: the page waits on that tap and
 * on no other.
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

/** The device's passkey sheet, as the page reaches it: what each ceremony came to is set per case. */
const sheet = {
  supported: jest.fn<Promise<boolean>, []>(),
  authenticate: jest.fn<Promise<unknown>, [unknown]>(),
  register: jest.fn<Promise<unknown>, [unknown]>(),
};

jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getSignupService: () => ({ initializeSignup }),
  PasskeyCeremonies: function PasskeyCeremonies() {
    return sheet;
  },
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
  Object.values(sheet).forEach((ceremony) => ceremony.mockReset());
  sheet.supported.mockResolvedValue(true);
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

describe('signing in with a passkey step: the page changes in place, and lands in the app only when the step passes', () => {
  const STEP = { kind: 'passkey', options: { challenge: 'the-first-challenge' } };
  const NEXT = { kind: 'passkey', options: { challenge: 'the-next-challenge' } };
  const ADD = { kind: 'addPasskey', options: { challenge: 'a-creation-challenge' } };
  const ASSERTION = { id: 'a-credential', type: 'public-key' };
  const REGISTRATION = { id: 'a-new-credential', type: 'public-key' };

  /** The door: answers each POST in turn (the last answer again after that) and keeps every body it was sent. */
  function mockDoor(...answers: object[]) {
    const sent: any[] = [];
    (global as any).fetch = jest.fn(async (_path: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      const answer = answers[Math.min(sent.length, answers.length) - 1];
      return { status: 200, statusText: 'OK', json: async () => answer };
    });
    return sent;
  }

  /** What stands on the page, read as a person would find it. */
  const page = () => ({
    fields: Array.from(container.querySelectorAll('input')).map((input) => input.type),
    // The one standing line under the title, when there is one (an error line and the message seat carry a role).
    address: container.querySelector('p:not([role])')?.textContent ?? null,
    acts: container.querySelectorAll('[data-signin-act] button').length,
    line: container.querySelector('[role="alert"]')?.textContent ?? null,
    seat: container.querySelector('[role="status"]')?.textContent ?? null,
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function signInWithPassword() {
    await renderPage(loginPage.component, '/login');
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();
    await settle();
  }

  async function tap(selector: string) {
    await act(async () => {
      (container.querySelector(selector) as HTMLButtonElement).click();
    });
    await settle();
  }
  const tapTheStep = () => tap('[data-signin-act] button');

  /** Whether the page's one act — the step's button, or the password form's — can be pressed. */
  const actIsFree = () =>
    !(container.querySelector('[data-signin-act] button, button[type="submit"]') as HTMLButtonElement).disabled;

  async function typeThePasswordAgain() {
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();
    await settle();
  }

  /** A request the door never answers: it fails where it was sent from. */
  const NO_ANSWER = 'the request fails';
  /** What a request the door held comes to once it is let go: the door's answer, or none at all. */
  type Late = object | typeof NO_ANSWER;
  /** Every way a tap the person left can end afterwards: an open session, a new step, a failure. */
  const LATE: Late[] = [{}, { error: 'the door’s line for a refusal', secondStep: NEXT }, NO_ANSWER];

  /**
   * The door answers the password with the step at once, and holds each answer to the step until
   * the case lets it go: `answer(n, late)` ends the n-th request the step sent, counted from 0.
   */
  function doorHoldingTheStep() {
    const sent: any[] = [];
    const held: Array<(late: Late) => void> = [];
    (global as any).fetch = jest.fn(async (_path: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      if ('email' in body) {
        return { status: 200, statusText: 'OK', json: async () => ({ secondStep: STEP }) };
      }
      const late = await new Promise<Late>((resolve) => held.push(resolve));
      if (late === NO_ANSWER) {
        throw new TypeError('Failed to fetch');
      }
      return { status: 200, statusText: 'OK', json: async () => late };
    });
    return { sent, answer: (request: number, late: Late) => held[request](late) };
  }

  it('the second state shows the address just typed and one button, and no field; its tap hands the door what the sheet answered, and only then is the person in the app', async () => {
    const sent = mockDoor({ secondStep: STEP }, {});
    sheet.authenticate.mockResolvedValue({ status: 'done', response: ASSERTION });
    await signInWithPassword();

    expect(page()).toMatchObject({ fields: [], address: EMAIL, acts: 1, line: null });
    // The password alone landed nobody anywhere, and the sheet waits for the tap.
    expect(locationSpy.replace).not.toHaveBeenCalled();
    expect(sheet.authenticate).not.toHaveBeenCalled();

    await tapTheStep();

    expect(sheet.authenticate).toHaveBeenCalledWith(STEP.options);
    expect(sent).toEqual([{ email: EMAIL, password: PASSWORD }, { passkey: ASSERTION }]);
    expect(locationSpy.replace).toHaveBeenCalledWith('/');
    expect(locationSpy.hrefSets).toEqual([]);
  });

  it('a sheet the person closes makes no request and the same step is presented again; a refusal arrives with a new step, which the next tap presents', async () => {
    const sent = mockDoor({ secondStep: STEP }, { error: 'the door’s line for a refusal', secondStep: NEXT }, {});
    sheet.authenticate.mockResolvedValueOnce({ status: 'cancelled' });
    sheet.authenticate.mockResolvedValue({ status: 'done', response: ASSERTION });
    await signInWithPassword();

    await tapTheStep();
    expect(sent).toHaveLength(1);
    expect(page()).toMatchObject({ fields: [], acts: 1 });
    expect(page().line).toBeTruthy();

    await tapTheStep();
    expect(sheet.authenticate.mock.calls.map(([options]) => options)).toEqual([STEP.options, STEP.options]);
    expect(sent).toHaveLength(2);
    expect(page()).toMatchObject({ fields: [], acts: 1, line: 'the door’s line for a refusal' });
    expect(locationSpy.replace).not.toHaveBeenCalled();

    await tapTheStep();
    expect(sheet.authenticate).toHaveBeenLastCalledWith(NEXT.options);
    expect(locationSpy.replace).toHaveBeenCalledWith('/');
  });

  it('restart shows the password form again, with the door’s line in the message seat; so does a step the door did not answer; "use a different account" goes back with no line', async () => {
    mockDoor({ secondStep: STEP }, { error: 'the door’s line for the end', restart: true });
    sheet.authenticate.mockResolvedValue({ status: 'done', response: ASSERTION });
    await signInWithPassword();
    await tapTheStep();

    expect(page()).toMatchObject({ fields: ['email', 'password'], acts: 0, seat: 'the door’s line for the end' });
    expect(locationSpy.replace).not.toHaveBeenCalled();

    // A step that failed on the server: no 200, no JSON.
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ secondStep: STEP }) })
      .mockResolvedValue({
        status: 404,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();
    await settle();
    expect(page()).toMatchObject({ fields: [], acts: 1, seat: null });
    await tapTheStep();
    expect(page().fields).toEqual(['email', 'password']);
    expect(page().seat).toBeTruthy();
    expect(locationSpy.replace).not.toHaveBeenCalled();

    // The person's own way back.
    mockDoor({ secondStep: STEP });
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();
    await settle();
    await tap('[data-signin-link="other-account"]');
    expect(page()).toMatchObject({ fields: ['email', 'password'], acts: 0, seat: null, line: null });
  });

  it('a step whose request never reaches the door — no network at the tap — is a line above the same button, which is free again; nothing is thrown, nobody is in the app, and the next tap tries again', async () => {
    const sent: any[] = [];
    (global as any).fetch = jest.fn(async (_path: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      if (sent.length === 2) {
        throw new TypeError('Failed to fetch');
      }
      return { status: 200, statusText: 'OK', json: async () => (sent.length === 1 ? { secondStep: STEP } : {}) };
    });
    sheet.authenticate.mockResolvedValue({ status: 'done', response: ASSERTION });
    await signInWithPassword();

    // A rejection nobody handled would fail this case where it happened: the runner reports it.
    await tapTheStep();

    expect(sent).toHaveLength(2);
    expect(page()).toMatchObject({ fields: [], address: EMAIL, acts: 1, seat: null });
    expect(page().line).toBeTruthy();
    expect(actIsFree()).toBe(true);
    expect(locationSpy.replace).not.toHaveBeenCalled();

    await tapTheStep();
    expect(sent).toEqual([{ email: EMAIL, password: PASSWORD }, { passkey: ASSERTION }, { passkey: ASSERTION }]);
    expect(locationSpy.replace).toHaveBeenCalledWith('/');
  });

  it('"use a different account" pressed while a tap is still out: the password form is free at once, and what the tap comes to afterwards changes nothing — an open session lands nobody in the app, a new step is not put back, a request that fails writes no line on the form, and a sheet that answers late is handed to nobody', async () => {
    const thePasswordFormFree = { fields: ['email', 'password'], acts: 0, seat: null, line: null };
    sheet.authenticate.mockResolvedValue({ status: 'done', response: ASSERTION });
    await renderPage(loginPage.component, '/login');

    for (const late of LATE) {
      const door = doorHoldingTheStep();
      await typeThePasswordAgain();
      await tapTheStep();
      // The request is out, and the step waits on it.
      expect(door.sent).toHaveLength(2);
      expect(actIsFree()).toBe(false);

      await tap('[data-signin-link="other-account"]');
      expect(page()).toMatchObject(thePasswordFormFree);
      expect(actIsFree()).toBe(true);
      expect(field('Email').disabled).toBe(false);

      door.answer(0, late);
      await settle();
      expect(locationSpy.replace).not.toHaveBeenCalled();
      expect(page()).toMatchObject(thePasswordFormFree);
      expect(actIsFree()).toBe(true);
    }

    // The sheet still up across the press: when it answers, nothing is sent.
    let answerTheSheet = (_answer: unknown) => {};
    sheet.authenticate.mockReturnValue(
      new Promise((resolve) => {
        answerTheSheet = resolve;
      })
    );
    const door = doorHoldingTheStep();
    await typeThePasswordAgain();
    await tapTheStep();
    await tap('[data-signin-link="other-account"]');
    expect(page()).toMatchObject(thePasswordFormFree);
    expect(actIsFree()).toBe(true);

    answerTheSheet({ status: 'done', response: ASSERTION });
    await settle();
    expect(door.sent).toEqual([{ email: EMAIL, password: PASSWORD }]);
    expect(locationSpy.replace).not.toHaveBeenCalled();
    expect(page()).toMatchObject(thePasswordFormFree);
  });

  it('a tap the person left is told from the tap that is out now: they go back, sign in again and tap, and while that tap is out the first one ends — its open session lands nobody in the app, its new step does not take the place of the step that stands, its failure writes no line, its sheet is handed to nobody — and the page still waits on the second tap, whose own answer it takes', async () => {
    const theSecondStepWaiting = { fields: [], address: EMAIL, acts: 1, line: null, seat: null };
    sheet.authenticate.mockResolvedValue({ status: 'done', response: ASSERTION });
    await renderPage(loginPage.component, '/login');
    const leaveSignInAgainAndTap = async () => {
      await tap('[data-signin-link="other-account"]');
      await typeThePasswordAgain();
      await tapTheStep();
    };

    for (const late of LATE) {
      const door = doorHoldingTheStep();
      await typeThePasswordAgain();
      await tapTheStep();
      await leaveSignInAgainAndTap();
      // Both taps' requests are at the door, and the page waits on the second.
      expect(door.sent).toHaveLength(4);
      expect(page()).toEqual(theSecondStepWaiting);
      expect(actIsFree()).toBe(false);

      door.answer(0, late);
      await settle();
      expect(locationSpy.replace).not.toHaveBeenCalled();
      expect(page()).toEqual(theSecondStepWaiting);
      expect(actIsFree()).toBe(false);

      // The second tap's own answer is the one the page takes: here, the end of its step.
      door.answer(1, { error: 'the door’s line for the end', restart: true });
      await settle();
      expect(page()).toMatchObject({ fields: ['email', 'password'], acts: 0, seat: 'the door’s line for the end' });
      expect(locationSpy.replace).not.toHaveBeenCalled();
    }

    // The first tap's sheet still up across all of it: when it answers, nothing of it is sent.
    let answerTheFirstSheet = (_answer: unknown) => {};
    sheet.authenticate.mockReturnValueOnce(
      new Promise((resolve) => {
        answerTheFirstSheet = resolve;
      })
    );
    const door = doorHoldingTheStep();
    await typeThePasswordAgain();
    await tapTheStep();
    await leaveSignInAgainAndTap();
    const theSecondTapAlone = [
      { email: EMAIL, password: PASSWORD },
      { email: EMAIL, password: PASSWORD },
      { passkey: ASSERTION },
    ];
    expect(door.sent).toEqual(theSecondTapAlone);

    answerTheFirstSheet({ status: 'done', response: { id: 'the-first-taps-credential', type: 'public-key' } });
    await settle();
    expect(door.sent).toEqual(theSecondTapAlone);
    expect(page()).toEqual(theSecondStepWaiting);
    expect(actIsFree()).toBe(false);

    // And the second tap's open session is the one that lands the person in the app.
    door.answer(0, {});
    await settle();
    expect(locationSpy.replace).toHaveBeenCalledWith('/');
  });

  it('where a passkey cannot start, no button stands — only a line and the way back; when the device only finds out at the tap, the line appears above the same button', async () => {
    mockDoor({ secondStep: STEP });
    sheet.supported.mockResolvedValue(false);
    await signInWithPassword();
    expect(page()).toMatchObject({ fields: [], acts: 0 });
    expect(page().line).toBeTruthy();
    expect(container.querySelectorAll('[data-signin-link="other-account"]')).toHaveLength(1);

    await tap('[data-signin-link="other-account"]');
    const sent = mockDoor({ secondStep: STEP });
    sheet.supported.mockResolvedValue(true);
    sheet.authenticate.mockResolvedValue({ status: 'unavailable' });
    fillSilently(field('Email'), EMAIL);
    fillSilently(field('Password'), PASSWORD);
    await submit();
    await settle();
    expect(page()).toMatchObject({ acts: 1, line: null });
    await tapTheStep();
    expect(page().acts).toBe(1);
    expect(page().line).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it('an account with no passkey yet is asked to add one: a title and one button, with no sentence standing under the title; the registration goes to the door and the person is in the app', async () => {
    const sent = mockDoor({ secondStep: ADD }, {});
    sheet.register.mockResolvedValue({ status: 'done', response: REGISTRATION });
    await signInWithPassword();

    expect(page()).toEqual({ fields: [], address: null, acts: 1, line: null, seat: null });
    expect(sheet.register).not.toHaveBeenCalled();

    await tapTheStep();
    expect(sheet.register).toHaveBeenCalledWith(ADD.options);
    expect(sent).toEqual([{ email: EMAIL, password: PASSWORD }, { addPasskey: REGISTRATION }]);
    expect(locationSpy.replace).toHaveBeenCalledWith('/');
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
