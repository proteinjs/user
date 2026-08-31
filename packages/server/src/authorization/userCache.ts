import moment from 'moment';
import { SessionDataCache } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { User, tables, guestUser, USER_SESSION_CACHE_KEY } from '@proteinjs/user';
import { DefaultAdminCredentials } from '../authentication/DefaultAdminCredentials';
import { UserActivityStamp } from './UserActivityStamp';

const logger = new Logger({ name: 'userCache' });
const userActivityStamp = new UserActivityStamp();

export const userCache: SessionDataCache<User> = {
  key: USER_SESSION_CACHE_KEY,
  create: async (sessionId: string, userEmail: string): Promise<User> => {
    let user = guestUser;
    if (userEmail) {
      const adminCredentials = DefaultAdminCredentials.getCredentials();
      if (adminCredentials && userEmail == adminCredentials.username) {
        const adminUser: User = {
          name: 'Admin',
          email: adminCredentials.username,
          password: adminCredentials.password,
          emailVerified: true,
          roles: ['admin'],
          created: moment(),
          updated: moment(),
          id: 'admin',
        };
        user = adminUser;
      } else {
        const accountUser = await getDbAsSystem().get(tables.User, { email: userEmail.toLowerCase() });
        if (accountUser && accountUser.status === 'deactivated') {
          // The session half of the deactivation gate (login half in authenticate): the session
          // cache is rebuilt per request, so a live session stops resolving the moment the
          // account is deactivated — every request runs as the unauthenticated guest.
          logger.warn({
            message: `Session references a deactivated account; resolving as unauthenticated`,
            obj: { sessionId, userEmail },
          });
        } else if (accountUser) {
          delete (accountUser as any)['password'];
          user = accountUser;
          // LAST ACTIVITY (human presence — UserActivityTable's contract): stamped HERE because
          // this cache build runs exactly once per session-cookie request (wrapRoute), i.e. only
          // for interactive transport. Background/seeded contexts (runInUserScope) set session
          // data directly and never pass through, so machinery acting as the user structurally
          // cannot stamp; the stamp itself refuses machine accounts. Fire-and-forget: the
          // returned promise never rejects, and a request never waits on its own stamp.
          void userActivityStamp.recordInteractiveRequest(user);
        } else {
          // A session can outlive its account (row deleted, or a dev auto-login for a never-created
          // email). Resolve it to the unauthenticated guest session — the client sees no
          // authenticated user and re-logs. Throwing here escapes the per-request session-cache
          // build as an unhandled rejection and downs the process.
          logger.warn({
            message: `Session references an account that does not exist; resolving as unauthenticated`,
            obj: { sessionId, userEmail },
          });
        }
      }
    }

    return user;
  },
};
