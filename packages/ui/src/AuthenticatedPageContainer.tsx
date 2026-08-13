import React from 'react';
import { PageContainer, PageContainerProps } from '@proteinjs/ui';
import { routes, guestUser, UserAuth, UserRepo, uiRoutes } from '@proteinjs/user';
import { canViewPage } from './pageAuth';

export type AuthenticatedPageContainerProps = Omit<PageContainerProps, 'auth'>;

export function AuthenticatedPageContainer(props: AuthenticatedPageContainerProps) {
  const { ...other } = props;
  const [isLoggedIn, setIsLoggedIn] = React.useState(UserAuth.isLoggedIn());

  return (
    <PageContainer
      auth={{
        isLoggedIn,
        canViewPage,
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
