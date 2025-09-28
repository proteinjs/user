import {
  Columns,
  Db,
  QueryBuilder,
  Record,
  Table,
  getColumnByName,
  getDb,
  getTables,
  withRecordColumns,
  Reference,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
} from '@proteinjs/db';

import { AccessGrant, AccessGrantTable } from './tables/AccessGrantTable';
import { UserRepo } from './UserRepo';
import { UserTable } from './tables/UserTable';
import { tables } from './tables/tables'

export interface SharedRecord<T extends SharedRecord = any> extends Record {
  permissionSource: Reference<T>;
  permissionSourceTable: string;
}

export const getSharedDb = getDb<SharedRecord>;
export const getSharedDbWithOverride = getDb<Omit<SharedRecord, 'permissionSource'>>;

export const getSharedDbAsSystem = <R extends SharedRecord = SharedRecord>() =>
  new Db<R>(undefined, undefined, undefined, true);

const getSharedRecordColumns = () => {
  return {
    permissionSource: new DynamicReferenceColumn('permission_source', 'permission_source_table', false, {
      defaultValue: async (table, insertObj) => {
        const user = new UserRepo().getUser();
        const db = getDb<AccessGrant>();

        await db.insert(tables.AccessGrant, {
          principal: new Reference(new UserTable().name, user.id),
          resource: new Reference(table.name, insertObj.id),
          resourceTable: table.name,
          accessLevel: 'admin',
        });

        return new Reference(table.name, insertObj.id);
      },
      addToQuery: async (qb, runAsSystem, operation) => {
        if (runAsSystem) {
          return;
        }

        const operationToLevel: globalThis.Record<typeof operation, AccessGrant['accessLevel'][]> = {
          read: ['read', 'write', 'admin', 'owner'],
          write: ['write', 'admin', 'owner'],
          delete: ['admin', 'owner'],
        };

        const subQuery = new QueryBuilder(tables.AccessGrant.name);
        subQuery.select({
          fields: ['resource'],
        });

        subQuery.condition({
          field: 'principal',
          operator: '=',
          value: new UserRepo().getUser().id,
        });

        subQuery.condition({
          field: 'accessLevel',
          operator: 'IN',
          value: operationToLevel[operation],
        });

        subQuery.condition({
          field: 'resourceTable',
          operator: '=',
          value: qb.tableName,
        });

        qb.condition({
          field: 'permissionSource',
          operator: 'IN',
          value: subQuery,
        });
      },
    }),
    permissionSourceTable: new DynamicReferenceTableNameColumn('permission_source_table', 'permission_source', {
      defaultValue: async (table) => table.name,
      forceDefaultValue: true,
    }),
  };
};

export function getSharedTables() {
  return getTables<SharedRecord>().filter((table) => isSharedTable(table));
}

export function isSharedTable(table: Table<any>): table is Table<SharedRecord> {
  return !!getColumnByName(table, getSharedRecordColumns().permissionSource.name);
}

/**
 * Wrapper function to add default Shared columns to your table's columns.
 *
 * @param columns your columns
 * @returns recordColumns & sourceRecordColumns & your columns
 */
export function withSharedRecordColumns<T extends SharedRecord>(
  columns: Columns<Omit<T, keyof SharedRecord>>
): Columns<SharedRecord> & Columns<Omit<T, keyof SharedRecord>> {
  return Object.assign(Object.assign({}, getSharedRecordColumns()), withRecordColumns<Record>(columns) as any);
}
