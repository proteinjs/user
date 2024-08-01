import { Service, serviceFactory } from '@proteinjs/service';
import { Invite } from '../tables/InviteTable';

export const getInviteService = serviceFactory<InviteService>('@proteinjs/user/InviteService');

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

export enum InviteErrorCode {
  UNEXPECTED_ERROR = 'UNEXPECTED_ERROR',
}

export type SendInviteResponse = {
  sent: boolean;
  errorCode?: InviteErrorCode;
  invite?: Invite;
};

export interface InviteService extends Service {
  sendInvite(email: string, invitePath: string): Promise<SendInviteResponse>;
  revokeInvite(email: string): Promise<void>;
  isTokenValid(token: string): Promise<boolean>;
  // create user where we process an invite token or not depending on the situation
}
