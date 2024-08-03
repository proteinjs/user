import { Service, serviceFactory } from '@proteinjs/service';
import { Invite } from '../tables/InviteTable';
import { User } from '../tables/UserTable';

export const getSignupService = serviceFactory<SignupService>('@proteinjs/user/SignupService');

export type SendInviteResponse = {
  sent: boolean;
  error?: string;
};

export type SignupType = 'inviteOnly' | 'inviteOptional' | 'signupOnly';

export type InitializeSignupResponse = {
  signupType?: SignupType;
  isReady: boolean;
  error?: string;
};

export interface SignupService extends Service {
  createUser(user: Pick<User, 'name' | 'email' | 'password'>, token?: string): Promise<void>;
  sendInvite(email: string): Promise<SendInviteResponse>;
  revokeInvite(email: string): Promise<void>;
  initializeSignup(inviteToken?: string): Promise<InitializeSignupResponse>;
}
