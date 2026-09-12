import { UserAuth, getUserPresenceService } from '@proteinjs/user';

/**
 * The browser half of "last active" (UserActivityTable's contract): a person's INPUT on the
 * page — pointer, key, touch, wheel — becomes one presence report per interval through
 * `UserPresenceService.recordPresence`, the only door that moves the `user_activity` stamp.
 *
 * Input, never transport: a tab left open polls, re-joins its socket rooms on every reconnect
 * and reloads when a deploy lands — all of it over a live session with nobody there, and all
 * of it read as presence when the stamp rode the request path (every user "active today").
 * Timers, focus and visibility are not input either (a tab can be visible with nobody in front
 * of it), so nothing here fires without a hand on the device.
 *
 * Fail-open: a report that fails is dropped; the next input after {@link RETRY_AFTER_MS}
 * tries again (never one request per keystroke against a down server). The listeners are
 * passive capture listeners on the document — they never block scrolling or a handler.
 */
export class UserPresenceReporter {
  /** Report at most this often — the same cadence class as the server stamp's own throttle. */
  static readonly REPORT_INTERVAL_MS = 1000 * 60 * 5;
  /** After a failed report, the next input retries only once this long has passed. */
  static readonly RETRY_AFTER_MS = 1000 * 30;
  /** The events that mean a person is here. */
  static readonly INPUT_EVENTS: readonly string[] = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

  private static instance: UserPresenceReporter | undefined;

  static get(): UserPresenceReporter {
    if (!UserPresenceReporter.instance) {
      UserPresenceReporter.instance = new UserPresenceReporter();
    }
    return UserPresenceReporter.instance;
  }

  private installed = false;
  private lastReportMs = 0;

  /** Listen for input on the document. Idempotent; a no-op outside a browser. */
  install(): void {
    if (this.installed || typeof document === 'undefined') {
      return;
    }
    this.installed = true;
    for (const type of UserPresenceReporter.INPUT_EVENTS) {
      document.addEventListener(type, this.onInput, { capture: true, passive: true });
    }
  }

  /** Stop listening (tests, teardown). The throttle history is kept. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;
    for (const type of UserPresenceReporter.INPUT_EVENTS) {
      document.removeEventListener(type, this.onInput, { capture: true });
    }
  }

  private onInput = (): void => {
    const now = Date.now();
    if (now - this.lastReportMs < UserPresenceReporter.REPORT_INTERVAL_MS) {
      return;
    }
    if (!UserAuth.isLoggedIn()) {
      return;
    }
    this.lastReportMs = now;
    void this.report(now);
  };

  private async report(at: number): Promise<void> {
    try {
      await getUserPresenceService().recordPresence();
    } catch (error) {
      // Dropped on purpose; the next input after the retry window reports again.
      this.lastReportMs = at - UserPresenceReporter.REPORT_INTERVAL_MS + UserPresenceReporter.RETRY_AFTER_MS;
    }
  }
}
