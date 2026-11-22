import React from 'react';
import { Navigate } from 'react-router-dom';
import { PageContainer, PageContainerProps } from '@proteinjs/ui';
import { guestUser, UserAuth, UserRepo, uiRoutes } from '@proteinjs/user';
import { AuthApi } from './auth/AuthApi';
import { canViewPage, waitingSessionDestination } from './pageAuth';
import { installUserPresenceReporter } from './presence/installUserPresenceReporter';

export type AuthenticatedPageContainerProps = Omit<PageContainerProps, 'auth'>;

export function AuthenticatedPageContainer(props: AuthenticatedPageContainerProps) {
  const { ...other } = props;
  const [isLoggedIn, setIsLoggedIn] = React.useState(UserAuth.isLoggedIn());

  // "Last active" (UserActivityTable's contract): every authenticated page reports a person's
  // input through the presence door. Installed here — the one root every consumer's
  // authenticated pages share — so no app wires it per page; idempotent across remounts.
  React.useEffect(() => {
    installUserPresenceReporter();
  }, []);

  // A session whose account waits for its email address to be confirmed has one screen. Sent there,
  // replaced in history, before anything of the routed page paints — sent, not rendered in place: a
  // product reads the ROUTED page for what surrounds it, so the routed page must be the one that paints.
  const confirmEmailAt = waitingSessionDestination(props.page);
  if (confirmEmailAt) {
    return <Navigate to={confirmEmailAt} replace />;
  }

  return (
    <PageContainer
      auth={{
        isLoggedIn,
        canViewPage,
        login: uiRoutes.auth.login,
        logout: async () => {
          await new AuthApi().logout();
          new UserRepo().setUser(guestUser);
          setIsLoggedIn(false);
          return uiRoutes.auth.login;
        },
      }}
      {...other}
    />
  );
}
