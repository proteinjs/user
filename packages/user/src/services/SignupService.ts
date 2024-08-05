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
  createUser(user: UserSignup, token?: string): Promise<void>;
  sendInvite(email: string): Promise<SendInviteResponse>;
  revokeInvite(email: string): Promise<void>;
  initializeSignup(inviteToken?: string): Promise<InitializeSignupResponse>;
}
