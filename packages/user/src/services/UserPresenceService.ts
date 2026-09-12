import { Service, serviceFactory } from '@proteinjs/service';

export const getUserPresenceService = serviceFactory<UserPresenceService>('@proteinjs/user/UserPresenceService');

/**
 * The page's HUMAN-INPUT signal — the ONE door that moves `user_activity` (UserActivityTable's
 * contract, "last active"). A page reports through it when a person interacts with it (pointer,
 * key, touch, wheel — `@proteinjs/user-ui`'s UserPresenceReporter, throttled per page); the
 * server throttles again and refuses machine accounts. Nothing else writes presence: not the
 * per-request session build, not a socket join, not a poll, not the reload a deploy pushes onto
 * an idle tab — those are TRANSPORT, and transport is what an open tab does all day with nobody
 * there.
 */
export interface UserPresenceService extends Service {
  /**
   * "A person interacted with this page just now." Stamps the CALLING user (the session's —
   * never an argument). Fire-and-forget on the client; the server never fails the call for a
   * lost stamp (a lost stamp is minutes of staleness at day grain, never an error).
   */
  recordPresence(): Promise<void>;
}
