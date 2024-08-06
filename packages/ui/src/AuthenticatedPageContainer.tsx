import React from 'react';
import { Page, PageContainer, PageContainerProps } from '@proteinjs/ui';
import { routes, guestUser, UserAuth, UserRepo, uiRoutes } from '@proteinjs/user';

export type AuthenticatedPageContainerProps = Omit<PageContainerProps, 'auth'>;

export function AuthenticatedPageContainer(props: AuthenticatedPageContainerProps) {
  const { ...other } = props;
  const [isLoggedIn, setIsLoggedIn] = React.useState(UserAuth.isLoggedIn());

  return (
    <PageContainer
      auth={{
        isLoggedIn,
        canViewPage: (page: Page) => {
          if (page.auth?.public) {
            return true;
          }

          if (page.auth?.allUsers) {
            return UserAuth.isLoggedIn();
          }

          if (!page.auth?.roles) {
            return UserAuth.hasRole('admin');
          }

          return UserAuth.hasRoles(page.auth?.roles);
        },
        login: uiRoutes.auth.login,
        logout: async () => {
          const response = await fetch(routes.logout.path, {
            method: routes.logout.method,
            redirect: 'follow',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
            },
          });
          if (response.status != 200) {
            throw new Error(`Failed to log out`);
          }

          new UserRepo().setUser(guestUser);
          setIsLoggedIn(false);
          return uiRoutes.auth.login;
        },
      }}
      {...other}
    />
  );
}
