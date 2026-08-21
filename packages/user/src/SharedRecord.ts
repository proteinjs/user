import {
  Columns,
  Db,
  QueryBuilder,
  Record,
  RecordAccessError,
  Table,
  getColumnByName,
  getDb,
  getDbAsSystem,
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

/** Levels that satisfy a WRITE capability on a permission source (read ⊂ write ⊂ admin ⊂ owner). */
const WRITE_ACCESS_LEVELS: AccessGrant['accessLevel'][] = ['write', 'admin', 'owner'];

/**
 * Does the CURRENT caller hold a write-or-greater grant on the given permission source? Queries
 * the caller's own grants directly as SYSTEM — never through the read-scoped `resource.get()` that
 * let a no-access caller's undefined fetch skip the check (the escalation-hole shape). This is the
 * one owner for "can this caller write into this permission scope", shared by the insert guard and
 * the zero-row write refusal below.
 */
async function callerHasWriteAccess(permissionSourceId: string, permissionSourceTableName: string): Promise<boolean> {
  const qb = new QueryBuilder(tables.AccessGrant.name);
  qb.condition({ field: 'principal', operator: '=', value: new UserRepo().getUser().id });
  qb.condition({ field: 'resource', operator: '=', value: permissionSourceId });
  qb.condition({ field: 'resourceTable', operator: '=', value: permissionSourceTableName });
  qb.condition({ field: 'accessLevel', operator: 'IN', value: WRITE_ACCESS_LEVELS });
  const grants = await getDbAsSystem<AccessGrant>().query(tables.AccessGrant, qb);
  return grants.length > 0;
}

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
            // The creator's owner grant is PLATFORM-CONFERRED, not something the user grants
            // themselves — write it as SYSTEM. Running it as the caller only ever worked because
            // AccessGrantTable.onBeforeInsert opened with a read-scoped bypass; with that bypass
            // removed (escalation fix) a caller-context bootstrap grant would be denied for having
            // no pre-existing admin grant. System context is both correct and self-authorizing.
            const db = getDbAsSystem<AccessGrant>();

            await db.insert(tables.AccessGrant, {
              principal: new Reference(new UserTable().name, user.id),
              resource: new Reference(table.name, insertObj.id),
              resourceTable: table.name,
              accessLevel: 'owner',
            });
          }

          return new Reference(table.name, insertObj.id);
        }),
      // ROW-INJECTION GUARD (the unguarded-insert hole): db.insert had no capability check, and
      // supplying `permissionSource` explicitly skips the owner-grant default above — so any
      // authenticated caller could attach a row into ANY resource's permission scope. Require the
      // caller to hold write+ on the referenced source for every non-system insert. The bootstrap
      // owner insert passes because the system-context owner grant already exists by the time
      // insert hooks run (defaults run before hooks); a derived source (e.g. a Task inheriting its
      // Thought's scope) passes only for a caller who can write that Thought.
      onBeforeInsert: async (insertObj, runAsSystem) => {
        if (runAsSystem || skipAccessGrantsEnabled()) {
          return;
        }

        const permissionSource = insertObj.permissionSource as Reference<any> | undefined;
        const sourceId = permissionSource?._id;
        const sourceTable = permissionSourceTableName ?? (insertObj as any).permissionSourceTable;
        if (!sourceId || !sourceTable) {
          // Malformed shared record — let the serializer's missing-field failure surface it rather
          // than silently allowing an unscoped row.
          return;
        }

        if (!(await callerHasWriteAccess(sourceId, sourceTable))) {
          throw new RecordAccessError(
            `User does not have write access to the permission source (${sourceTable}:${sourceId})`
          );
        }
      },
      // TYPED REFUSAL (silent-refusal defect): an id-targeted single-row content write by a caller
      // whose grant is insufficient matches 0 rows through the subquery below and used to return a
      // silent 0 — a tool reports false success. When such a write matches nothing AND the row in
      // fact exists (system truth) AND the caller lacks write+ on its source, surface a typed
      // error. An absent row, or a caller who DOES hold write+ (e.g. a same-value no-op), is left
      // as a legitimate 0 — never mis-flagged.
      onZeroRowFilteredWrite: async (table, id, operation, runAsSystem) => {
        if (runAsSystem || skipAccessGrantsEnabled()) {
          return;
        }

        const systemRow = await getSharedDbAsSystem().get(table as Table<SharedRecord>, { id });
        if (!systemRow) {
          return;
        }

        const sourceId = systemRow.permissionSource?._id;
        const sourceTable = permissionSourceTableName ?? systemRow.permissionSourceTable ?? table.name;
        if (!sourceId) {
          return;
        }

        if (!(await callerHasWriteAccess(sourceId, sourceTable))) {
          throw new RecordAccessError(`User does not have ${operation} access to ${table.name}:${id}`);
        }
      },
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
