import { Session } from '@proteinjs/server-api';
import { AuthenticatedUser, AuthenticatedUserRepo } from '@proteinjs/user-auth';
import { User } from './tables/UserTable';
import { USER_SESSION_CACHE_KEY } from './cacheKeys';

export class UserRepo implements AuthenticatedUserRepo {
  getUser(): Omit<User, 'roles'> & AuthenticatedUser {
    const user = Object.assign({}, Session.getDataByKey<User>(USER_SESSION_CACHE_KEY));
    // Roles are stored typed (`role_list`); rows that predate the roles backfill migration read
    // as null, and a context without session data has none — both mean "no roles".
    const roles = user.roles ?? [];
    return Object.assign(user, { roles });
  }

  setUser(user: User) {
    Session.setDataByKey(USER_SESSION_CACHE_KEY, user);
  }
}
