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
import { tables } from './tables/tables';

export interface SharedRecord<T extends SharedRecord = any> extends Record {
  permissionSource: Reference<T>;
  permissionSourceTable: string;
}

export const getSharedDb = getDb<SharedRecord>;
export const getSharedDbWithOverride = getDb<Omit<SharedRecord, 'permissionSource'>>;

export const getSharedDbAsSystem = <R extends SharedRecord = SharedRecord>() =>
  new Db<R>(undefined, undefined, undefined, true);

/**
 * When true, skips AccessGrant creation during inserts and skips the
 * permission subquery filter on reads. Use in test environments where
 * AccessGrant accumulation degrades Spanner emulator performance.
 *
 * The flag lives on the global object (window in browser, globalThis elsewhere) rather than in
 * module scope: per-package installs can put multiple live copies of @proteinjs/user in one
 * process (each sibling package's nested node_modules hosts its own copy), and module-scoped
 * state splits per copy — a caller toggling one copy while the AccessGrant closures enforce
 * from another (silent authz-toggle no-op, 2026-08-14 incident). Anchoring on the global gives
 * every copy the same state — same pattern as reflection's SourceRepository and db's
 * ReferenceCache.
 */
const SKIP_ACCESS_GRANTS_GLOBAL_KEY = '__proteinjs_user_skipAccessGrants';

const getGlobal = (): any => (typeof window !== 'undefined' ? window : globalThis);

export function setSkipAccessGrants(value: boolean) {
  getGlobal()[SKIP_ACCESS_GRANTS_GLOBAL_KEY] = value;
}

export function skipAccessGrantsEnabled(): boolean {
  return getGlobal()[SKIP_ACCESS_GRANTS_GLOBAL_KEY] === true;
}

type SharedRecordOptions = {
  permissionSourceTableName?: string;
  permissionSourceDefaultValue?: (table: Table<any>, insertObj: any & Record) => Promise<any>;
};

const getSharedRecordColumns = ({
  permissionSourceTableName,
  permissionSourceDefaultValue,
}: SharedRecordOptions = {}) => {
  return {
    permissionSource: new DynamicReferenceColumn('permission_source', 'permission_source_table', false, {
      defaultValue:
        permissionSourceDefaultValue ??
        (async (table, insertObj) => {
          if (!skipAccessGrantsEnabled()) {
            const user = new UserRepo().getUser();
            const db = getDb<AccessGrant>();

            await db.insert(tables.AccessGrant, {
              principal: new Reference(new UserTable().name, user.id),
              resource: new Reference(table.name, insertObj.id),
              resourceTable: table.name,
              accessLevel: 'owner',
            });
          }

          return new Reference(table.name, insertObj.id);
        }),
      addToQuery: async (qb, runAsSystem, operation) => {
        if (runAsSystem || skipAccessGrantsEnabled()) {
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
          value: permissionSourceTableName ?? qb.tableName,
        });

        qb.condition({
          field: 'permissionSource',
          operator: 'IN',
          value: subQuery,
        });
      },
    }),
    permissionSourceTable: new DynamicReferenceTableNameColumn('permission_source_table', 'permission_source', {
      defaultValue: async (table) => permissionSourceTableName ?? table.name,
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
  columns: Columns<Omit<T, keyof SharedRecord>>,
  options?: SharedRecordOptions
): Columns<SharedRecord> & Columns<Omit<T, keyof SharedRecord>> {
  return Object.assign(Object.assign({}, getSharedRecordColumns(options)), withRecordColumns<Record>(columns) as any);
}
