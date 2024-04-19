import React from 'react';
import { Page, PageContainer, PageContainerProps } from '@proteinjs/ui';
import { routes, guestUser, UserAuth, UserRepo } from '@proteinjs/user';
import { loginPath } from './pages/Login';

export type AuthenticatedPageContainerProps = Omit<PageContainerProps, 'auth'>;

export function AuthenticatedPageContainer(props: AuthenticatedPageContainerProps) {
    const { ...other } = props;
    const [isLoggedIn, setIsLoggedIn] = React.useState(UserAuth.isLoggedIn());

    return (
        <PageContainer
            auth={{
                isLoggedIn,
                canViewPage: (page: Page) => {
                    if (page.auth?.public)
                        return true;

                    if (page.auth?.allUsers)
                        return UserAuth.isLoggedIn();

                    if (!page.auth?.roles)
                        return UserAuth.hasRole('admin');

                    return UserAuth.hasRoles(page.auth?.roles);
                },
                login: loginPath,
                logout: async () => {
                    const response = await fetch(routes.logout.path, {
                        method: routes.logout.method,
                        redirect: 'follow',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });
                    if (response.status != 200)
                        throw new Error(`Failed to log out`);

                    new UserRepo().setUser(guestUser);
                    setIsLoggedIn(false);
                    return loginPath;
                }
            }}
            {...other}
        />
    );
}