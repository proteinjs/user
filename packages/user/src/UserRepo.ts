import { Session } from '@proteinjs/server-api';
import { AuthenticatedUser, AuthenticatedUserRepo } from '@proteinjs/user-auth';
import { User } from './tables/UserTable';
import { USER_SESSION_CACHE_KEY } from './cacheKeys';

export class UserRepo implements AuthenticatedUserRepo {
    getUser(): Omit<User, 'roles'> & AuthenticatedUser {
        const user = Object.assign({}, Session.getDataByKey<User>(USER_SESSION_CACHE_KEY));
        const roles = user.roles ? user.roles.split(',') : [];
        return Object.assign(user, { roles });
    }

    setUser(user: User) {
        Session.setDataByKey(USER_SESSION_CACHE_KEY, user);
    }
}