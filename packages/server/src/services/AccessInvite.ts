import moment from 'moment';

import { getDbAsSystem, Record, Reference } from '@proteinjs/db';
import { tables, AccessInvite as AccessInviteRecord, UserRepo } from '@proteinjs/user';
import { AccessInviteService, CreateAccessInviteParams, CreateAccessInviteResponse } from '@proteinjs/user';

export class AccessInvite<T extends Record> implements AccessInviteService<T> {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  async createAccessInvite(params: CreateAccessInviteParams): Promise<CreateAccessInviteResponse> {
    const { resourceTable, resourceId, expiresInDays } = params;

    const db = getDbAsSystem();
    const tokenExpiresAt = moment().add(expiresInDays ?? 7, 'days');

    const invite = await db.insert(tables.AccessInvite, {
      resource: new Reference(resourceTable, resourceId),
      resourceTable,
      tokenExpiresAt,
    });

    return {
      token: invite.token!,
      tokenExpiresAt: invite.tokenExpiresAt,
    };
  }

  async acceptAccessInvite(token: string): Promise<T | undefined> {
    const db = getDbAsSystem();
    const invite = (await db.get(tables.AccessInvite, { token })) as AccessInviteRecord<T>;
    if (!invite) {
      throw new Error(`Invalid invite token`);
    }

    if (moment().isAfter(invite.tokenExpiresAt)) {
      throw new Error(`Invite has expired`);
    }

    if (invite.accepted) {
      throw new Error(`Invite has already been accepted`);
    }

    const user = new UserRepo().getUser();
    await db.insert(tables.AccessGrant, {
      principal: Reference.fromObject(tables.User.name, user),
      resource: invite.resource,
      resourceTable: invite.resourceTable,
      accessLevel: 'write',
    });

    await db.update(tables.AccessInvite, {
      id: invite.id,
      accepted: true,
      acceptedBy: new Reference(tables.User.name, new UserRepo().getUser().id),
      acceptedAt: moment(),
    });

    return await invite.resource.get();
  }
}
