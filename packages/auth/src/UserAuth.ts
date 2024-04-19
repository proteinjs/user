import { Loadable, SourceRepository } from '@proteinjs/reflection'
import { guestUser } from './guestUser'

export interface AuthenticatedUser {
    email: string;
    roles: string[];
}

export interface AuthenticatedUserRepo extends Loadable {
    getUser(): AuthenticatedUser;
}

export const getAuthenticatedUserRepo = () => SourceRepository.get().object<AuthenticatedUserRepo|undefined>('@proteinjs/user-auth/AuthenticatedUserRepo');

export class UserAuth {
    private static userRepo?: AuthenticatedUserRepo;

    private static getUserRepo() {
        if (!UserAuth.userRepo)
            UserAuth.userRepo = getAuthenticatedUserRepo();

        return UserAuth.userRepo;
    }

    static isLoggedIn(): boolean {
        const userRepo = UserAuth.getUserRepo();
        if (!userRepo)
            return true;

        const user = userRepo.getUser();
        return user.email != guestUser.email;
    }

    /**
     * @return true if user has role or user has role 'admin'
     */
    static hasRole(role: string): boolean {
        const userRepo = UserAuth.getUserRepo();
        if (!userRepo)
            return true;

        const user = userRepo.getUser();
        if (user.roles.includes('admin'))
            return true;

        return user.roles.includes(role);
    }

    /**
     * @param has (default) `all` - return true if user has all roles
     * @param has `at least one` - return true if user has at least one role
     */
    static hasRoles(roles: string[], has: 'all'|'at least one' = 'all'): boolean {
        const userRepo = UserAuth.getUserRepo();
        if (!userRepo)
            return true;

        for (const role of roles) {
            if (!UserAuth.hasRole(role)) {
                if (has === 'all')
                    return false;
            } else {
                if (has === 'at least one')
                    return true;
            }
        }

        return has === 'all';
    }
}