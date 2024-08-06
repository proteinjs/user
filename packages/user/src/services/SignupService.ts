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

export type UserSignup = Pick<User, 'name' | 'password'> & {
  email?: User['email'];
};

export interface SignupService extends Service {
  /**
   * Creates a new user account.
   * @param {UserSignup} user - User signup information. `user.email` is required if no token is provided.
   * @param {string} [token] - Optional invite token. If provided, the corresponding invite record will be used to get the user's email.
   * @returns {Promise<void>}
   */
  createUser(user: UserSignup, token?: string): Promise<void>;
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
