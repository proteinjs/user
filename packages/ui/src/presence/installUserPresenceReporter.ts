import { UserPresenceReporter } from './UserPresenceReporter';

/**
 * Install the browser half of "last active": the page's human-input report (see
 * {@link UserPresenceReporter}). `AuthenticatedPageContainer` installs it on mount, so every
 * consumer app's authenticated pages report presence without wiring; a consumer with its own
 * page container calls this once at its root. Idempotent.
 */
export function installUserPresenceReporter(): void {
  UserPresenceReporter.get().install();
}
