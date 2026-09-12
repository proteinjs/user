/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * The browser half of "last active" (UserActivityTable's contract): presence is reported from a
 * person's INPUT on the page and from nothing else. These pin the reporter's outcomes against
 * the presence door (`getUserPresenceService` is the only mock; time is faked):
 * a timer is not a person, an input is, the throttle holds, a logged-out page reports nothing,
 * and a failed report retries on the next input after the retry window.
 */
import { UserAuth } from '@proteinjs/user';
import { UserPresenceReporter } from '../src/presence/UserPresenceReporter';

const recordPresence = jest.fn<Promise<void>, []>();

jest.mock('@proteinjs/user', () => ({
  ...jest.requireActual('@proteinjs/user'),
  getUserPresenceService: () => ({ recordPresence }),
}));

const input = (type: string) => document.dispatchEvent(new Event(type, { bubbles: true }));
/** Let the fire-and-forget report settle (one macrotask under fake timers). */
const settle = async () => {
  await jest.advanceTimersByTimeAsync(0);
};

let reporter: UserPresenceReporter;
let isLoggedIn: jest.SpyInstance<boolean, []>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
  recordPresence.mockReset().mockResolvedValue(undefined);
  isLoggedIn = jest.spyOn(UserAuth, 'isLoggedIn').mockReturnValue(true);
  reporter = new UserPresenceReporter();
  reporter.install();
});

afterEach(() => {
  reporter.uninstall();
  isLoggedIn.mockRestore();
  jest.useRealTimers();
});

describe('UserPresenceReporter — input is presence, transport is not', () => {
  it('a timer is not a person: an installed page with no input reports nothing, however long it sits', async () => {
    await jest.advanceTimersByTimeAsync(UserPresenceReporter.REPORT_INTERVAL_MS * 6);
    expect(recordPresence).not.toHaveBeenCalled();
  });

  it('a pointer on the page reports presence once', async () => {
    input('pointerdown');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(1);
  });

  it('every input kind counts — key, touch, wheel — each first-in-window input reports', async () => {
    for (const type of ['keydown', 'touchstart', 'wheel']) {
      input(type);
      await settle();
      jest.advanceTimersByTime(UserPresenceReporter.REPORT_INTERVAL_MS);
    }
    expect(recordPresence).toHaveBeenCalledTimes(3);
  });

  it('throttles: more input inside the interval reports nothing; the first input after it reports again', async () => {
    input('pointerdown');
    input('keydown');
    jest.advanceTimersByTime(UserPresenceReporter.REPORT_INTERVAL_MS - 1000);
    input('wheel');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    input('touchstart');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(2);
  });

  it('a logged-out page reports nothing, and does not spend its throttle window', async () => {
    isLoggedIn.mockReturnValue(false);
    input('pointerdown');
    await settle();
    expect(recordPresence).not.toHaveBeenCalled();

    // The person logs in and the next input reports at once — no stale window from the guest input.
    isLoggedIn.mockReturnValue(true);
    input('pointerdown');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(1);
  });

  it('fail-open: a failed report is dropped, and the next input after the retry window reports again', async () => {
    recordPresence.mockRejectedValueOnce(new Error('server away'));
    input('pointerdown');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(1);

    // Inside the retry window: still nothing (never a request per keystroke against a down server).
    jest.advanceTimersByTime(UserPresenceReporter.RETRY_AFTER_MS - 1000);
    input('keydown');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    input('keydown');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(2);
  });

  it('install is idempotent: a second install adds no second listener', async () => {
    reporter.install();
    input('pointerdown');
    await settle();
    expect(recordPresence).toHaveBeenCalledTimes(1);
  });
});
