import moment from 'moment';

import { getDb, getDbAsSystem, Record, Reference } from '@proteinjs/db';
import {
  tables,
  AccessInvite as AccessInviteRecord,
  UserRepo,
  ACCESS_LEVEL_RANK,
  maxAccessLevel,
} from '@proteinjs/user';
import { AccessInviteService, CreateAccessInviteParams, CreateAccessInviteResponse } from '@proteinjs/user';

export class AccessInvite<T extends Record> implements AccessInviteService<T> {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  async createAccessInvite(params: CreateAccessInviteParams): Promise<CreateAccessInviteResponse> {
    const { resourceTable, resourceId, expiresInDays, accessLevel } = params;

    // Insert as the CALLER, not as system — AccessInviteTable's onBeforeInsert enforces the
    // documented contract (only admin/owner on the resource mints invites). The old system-db
    // insert bypassed that hook, letting any authenticated user mint themselves a write invite
    // for any resource id they learned.
    const db = getDb();
    const tokenExpiresAt = moment().add(expiresInDays ?? 7, 'days');

    const invite = await db.insert(tables.AccessInvite, {
      resource: new Reference(resourceTable, resourceId),
      accessLevel,
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

    // Invite links are durable, multi-use capabilities: valid for every holder until the link
    // expires, idempotent per acceptor. Accepting reconciles the caller's grant on the resource
    // UP to the invite's level — insert when absent, upgrade the existing grant when lower,
    // never downgrade and never duplicate. (The one-shot `accepted` gate this replaces burned
    // the token on the FIRST open ever — commonly the owner testing their own link — after
    // which every real recipient failed to load the resource at all.)
    const user = new UserRepo().getUser();
    const existingGrants = await db.query(tables.AccessGrant, {
      principal: user.id,
      resource: invite.resource._id,
      resourceTable: invite.resourceTable,
    });
    const currentLevel = maxAccessLevel(existingGrants.map((grant) => grant.accessLevel));
    if (!currentLevel) {
      await db.insert(tables.AccessGrant, {
        principal: new Reference(tables.User.name, user.id),
        resource: invite.resource,
        resourceTable: invite.resourceTable,
        accessLevel: invite.accessLevel,
      });
    } else if (ACCESS_LEVEL_RANK[invite.accessLevel] > ACCESS_LEVEL_RANK[currentLevel]) {
      const bearer = existingGrants.find((grant) => grant.accessLevel === currentLevel)!;
      await db.update(tables.AccessGrant, { id: bearer.id, accessLevel: invite.accessLevel });
    }

    // Last-accept telemetry only — `accepted` no longer gates anything.
    await db.update(tables.AccessInvite, {
      id: invite.id,
      accepted: true,
      acceptedBy: new Reference(tables.User.name, user.id),
      acceptedAt: moment(),
    });

    return await invite.resource.get();
  }
}
