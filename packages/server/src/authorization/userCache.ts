import moment from 'moment';
import { SessionDataCache } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { User, tables, guestUser, USER_SESSION_CACHE_KEY } from '@proteinjs/user';
import { DefaultAdminCredentials } from '../authentication/DefaultAdminCredentials';

const logger = new Logger({ name: 'userCache' });

/**
 * The per-request session-cache build: resolves the session's email to the account row every
 * request that rides a session cookie (wrapRoute), and every socket event (util-server's
 * SocketSessionContext). It resolves IDENTITY only — it does not write the presence stamp
 * (`user_activity`, UserActivityTable's contract): this build runs for an idle tab's polls, a
 * socket's room re-joins on every reconnect, the reload a deploy pushes onto every open tab —
 * transport, not a person. Presence is written from the page's human-input report alone
 * (UserPresence.recordPresence).
 */
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
            obj: { sessionId, account: new RequestDigests().account(userEmail) },
          });
        } else if (accountUser) {
          delete (accountUser as any)['password'];
          user = accountUser;
        } else {
          // A session can outlive its account (row deleted, or a dev auto-login for a never-created
          // email). Resolve it to the unauthenticated guest session — the client sees no
          // authenticated user and re-logs. Throwing here escapes the per-request session-cache
          // build as an unhandled rejection and downs the process.
          logger.warn({
            message: `Session references an account that does not exist; resolving as unauthenticated`,
            obj: { sessionId, account: new RequestDigests().account(userEmail) },
          });
        }
      }
    }

    return user;
  },
};
