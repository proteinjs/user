import type { Record } from '@proteinjs/db';
import type { Moment } from 'moment';

import { Service, serviceFactory } from '@proteinjs/service';

export const getAccessInviteService = <T extends Record>() =>
  serviceFactory<AccessInviteService<T>>('@proteinjs/user/AccessInviteService');

export type CreateAccessInviteParams = {
  resourceTable: string;
  resourceId: string;
  expiresInDays?: number;
};

export type CreateAccessInviteResponse = {
  token: string;
  tokenExpiresAt: Moment;
};

export interface AccessInviteService<T extends Record> extends Service {
  /**
   * Creates an access invite for a resource. Caller must have admin access to the resource.
   * Returns a token and expiry which can be embedded as a query parameter in a shareable URL.
   */
  createAccessInvite(params: CreateAccessInviteParams): Promise<CreateAccessInviteResponse>;
  /**
   * Accepts an access invite using the provided token. The current authenticated user will be granted access.
   */
  acceptAccessInvite(token: string): Promise<T | undefined>;
}
