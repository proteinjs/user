import { Service, serviceFactory } from '@proteinjs/service';
import { User } from '../tables/UserTable';
import { Invite } from '../tables/InviteTable';

export const getSignupService = serviceFactory<SignupService>('@proteinjs/user/SignupService');

export type SendInviteResponse = {
  sent: boolean;
  error?: string;
};

export type InitializeSignupResponse = {
  isReady: boolean;
  error?: string;
  isInviteOnly?: boolean;
  invite?: Omit<Invite, 'token'>;
};

/** The signup route's request body (`routes.signup`). `email` is required if no token is provided. */
export type UserSignup = Pick<User, 'name' | 'password'> & {
  email?: User['email'];
};

/**
 * Account CREATION is not on this interface: signing up establishes a session in the same
 * request (auto-login), and session establishment is a request-level concern services never
 * see — it lives on the `routes.signup` route (user-server `src/routes/signup.ts`), beside
 * login. This service owns the rest of the signup flow: pre-submit initialization and invite
 * management.
 */
export interface SignupService extends Service {
  /** Creates invite record and sends email to the invited user.
   * If invite already exists for the email, it will update the existing record with a new token and send a new email.
   */
  sendInvite(email: string): Promise<SendInviteResponse>;
  /** Deletes invite record associated with the email. */
  revokeInvite(email: string): Promise<void>;
  /**
   * Initializes signup process, validating invite configuration and token if provided.
   * Invite configuration defaults to invite optional.
   * @see `DefaultInviteConfigFactory` for configuring invite setting
   */
  initializeSignup(inviteToken?: string): Promise<InitializeSignupResponse>;
}
