import type { Moment } from 'moment';

import {
  BooleanColumn,
  DateTimeColumn,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  getDbAsSystem,
  QueryBuilderFactory,
  Record,
  Reference,
  ReferenceColumn,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';
import * as crypto from 'crypto';
import { UserRepo } from '../UserRepo';
import { AccessGrant, AccessGrantTable } from './AccessGrantTable';
import { User, UserTable } from './UserTable';

export type AccessInvite<T extends Record = any> = Record & {
  token?: string;
  tokenExpiresAt: Moment;
  resource: Reference<T>;
  resourceTable: string;
  accessLevel: AccessGrant['accessLevel'];
  accepted?: boolean;
  acceptedBy?: Reference<User>;
  acceptedAt?: Moment;
};

export class AccessInviteTable extends Table<AccessInvite> {
  name = 'access_invite';
  auth: Table<AccessInvite>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  columns = withRecordColumns<AccessInvite>({
    token: new StringColumn('token', {
      defaultValue: async () => crypto.randomBytes(32).toString('hex'),
      forceDefaultValue: true,
    }),
    tokenExpiresAt: new DateTimeColumn('expires_at'),
    accepted: new BooleanColumn('accepted', { defaultValue: async () => false }),
    acceptedBy: new ReferenceColumn('accepted_by', new UserTable().name, false),
    acceptedAt: new DateTimeColumn('accepted_at'),
    accessLevel: new StringColumn('access_level'),
    resource: new DynamicReferenceColumn('resource', 'resource_table'),
    resourceTable: new DynamicReferenceTableNameColumn('resource_table', 'resource', {
      onBeforeInsert: async (insertObj: AccessInvite, runAsSystem) => {
        if (runAsSystem) {
          return;
        }

        const adminAccessQb = new QueryBuilderFactory().createQueryBuilder(
          new AccessGrantTable() as Table<AccessGrant>,
          {
            principal: new UserRepo().getUser().id,
            resource: insertObj.resource._id,
            resourceTable: insertObj.resourceTable,
          }
        );

        adminAccessQb.condition({
          field: 'accessLevel',
          operator: 'IN',
          value: ['admin', 'owner'],
        });

        const hasAdminAccess =
          (await getDbAsSystem().query(new AccessGrantTable() as Table<AccessGrant>, adminAccessQb)).length > 0;

        if (!hasAdminAccess) {
          throw new Error(`User does not have admin access to resource`);
        }
      },
    }),
  });
}
