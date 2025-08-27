import {
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  getDbAsSystem,
  Record,
  Reference,
  ReferenceColumn,
  StringColumn,
  withRecordColumns,
} from '@proteinjs/db';

import { Table } from '@proteinjs/db';
import { User, UserTable } from './UserTable';
import { UserRepo } from '../UserRepo';

export type AccessGrant = Record & {
  principal: Reference<any>;
  resource: Reference<any>;
  resourceTable?: Table<any>['name'];
  accessLevel: 'read' | 'write' | 'admin';
};

export class AccessGrantTable extends Table<AccessGrant> {
  name = 'access_grant';
  auth: Table<AccessGrant>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  columns = withRecordColumns<AccessGrant>({
    accessLevel: new StringColumn('access_level'),
    principal: new ReferenceColumn<User>('principal', UserTable.name, false),
    resource: new DynamicReferenceColumn<any>('resource', 'resource_table', false),
    resourceTable: new DynamicReferenceTableNameColumn('resource_table', 'resource', {
      onBeforeInsert: async (insertObj: AccessGrant, runAsSystem) => {
        if (runAsSystem) {
          return;
        }

        // if the object doesn't exist yet, we should allow insert
        const resource = await insertObj.resource.get();
        if (!resource) {
          return;
        }

        const hasAdminAccess =
          (
            await getDbAsSystem().query(new AccessGrantTable() as Table<AccessGrant>, {
              accessLevel: 'admin',
              principal: new UserRepo().getUser().id,
              resource: insertObj.resource._id,
              resourceTable: insertObj.resourceTable,
            })
          ).length > 0;

        if (!hasAdminAccess) {
          throw new Error(`User does not have admin access to resource`);
        }
      },
    }),
  });
}
