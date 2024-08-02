import { Service, serviceFactory } from '@proteinjs/service';
import { Invite } from '../tables/InviteTable';
import { User } from '../tables/UserTable';

export const getSignupService = serviceFactory<SignupService>('@proteinjs/user/SignupService');

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

export type SendInviteResponse = {
  sent: boolean;
  error?: string;
  invite?: Invite;
};

export interface SignupService extends Service {
  createUser(user: Pick<User, 'name' | 'email' | 'password'>): Promise<void>;
  sendInvite(email: string): Promise<SendInviteResponse>;
  revokeInvite(email: string): Promise<void>;
  isInviteTokenValid(token: string): Promise<boolean>;
}
