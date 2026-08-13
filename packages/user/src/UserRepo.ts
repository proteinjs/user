import { Session } from '@proteinjs/server-api';
import { AuthenticatedUser, AuthenticatedUserRepo } from '@proteinjs/user-auth';
import { User } from './tables/UserTable';
import { USER_SESSION_CACHE_KEY } from './cacheKeys';

export type UserChangedListener = (user: User) => void;

export class UserRepo implements AuthenticatedUserRepo {
  private static userChangedListeners = new Set<UserChangedListener>();

  /**
   * Subscribe to user-record changes (every `setUser`, i.e. every session-cache refresh after a
   * user-info mutation). Lets UI surfaces (avatar chips, account header) re-render without a
   * reload. Returns an unsubscribe function.
   */
  static onUserChanged(listener: UserChangedListener): () => void {
    UserRepo.userChangedListeners.add(listener);
    return () => {
      UserRepo.userChangedListeners.delete(listener);
    };
  }

  getUser(): Omit<User, 'roles'> & AuthenticatedUser {
    const user = Object.assign({}, Session.getDataByKey<User>(USER_SESSION_CACHE_KEY));
    const roles = user.roles ? user.roles.split(',') : [];
    return Object.assign(user, { roles });
  }

  setUser(user: User) {
    Session.setDataByKey(USER_SESSION_CACHE_KEY, user);
    UserRepo.userChangedListeners.forEach((listener) => {
      // Standard emitter isolation: one subscriber throwing must not break the mutation path
      // (or starve the remaining subscribers).
      try {
        listener(user);
      } catch (error) {
        console.error('UserRepo userChanged listener threw', error);
      }
    });
  }
}
