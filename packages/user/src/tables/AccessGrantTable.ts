import {
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  getDbAsSystem,
  QueryBuilder,
  QueryBuilderFactory,
  Record,
  Reference,
  ReferenceColumn,
  StringColumn,
  withRecordColumns,
} from '@proteinjs/db';

import { Table } from '@proteinjs/db';
import { User, UserTable } from './UserTable';
import { UserRepo } from '../UserRepo';
import { tables } from './tables';

export type AccessGrant = Record & {
  principal: Reference<any>;
  resource: Reference<any>;
  resourceTable?: Table<any>['name'];
  accessLevel: 'read' | 'write' | 'admin' | 'owner';
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

        const adminAccessQb = new QueryBuilderFactory().createQueryBuilder(tables.AccessGrant, {
          principal: new UserRepo().getUser().id,
          resource: insertObj.resource._id,
          resourceTable: insertObj.resourceTable,
        });

        adminAccessQb.condition({
          field: 'accessLevel',
          operator: 'IN',
          value: ['admin', 'owner'],
        });

        const hasAdminAccess = (await getDbAsSystem().query(tables.AccessGrant, adminAccessQb)).length > 0;

        if (!hasAdminAccess) {
          throw new Error(`User does not have admin access to resource`);
        }
      },
      // Prevent direct updates and limit access to own or admin-accessible grants
      async addToQuery(qb, runAsSystem, operation) {
        if (runAsSystem) {
          return;
        }

        if (operation === 'write') {
          throw new Error('AccessGrants cannot be updated directly');
        }

        const currentUser = new UserRepo().getUser();

        const adminResourceSubQuery = new QueryBuilder(new AccessGrantTable().name);
        adminResourceSubQuery.select({ fields: ['resource'] });
        adminResourceSubQuery.condition({ field: 'principal', operator: '=', value: currentUser.id });
        adminResourceSubQuery.condition({ field: 'accessLevel', operator: 'IN', value: ['admin', 'owner'] });

        qb.or([
          { field: 'principal', operator: '=', value: currentUser.id },
          {
            field: 'resource',
            operator: 'IN',
            value: adminResourceSubQuery,
          },
        ]);
      },
    }),
  });
}
