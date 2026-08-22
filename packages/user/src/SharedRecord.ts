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

/**
 * Is this insert a SCOPE ROOT — a row that is its OWN permission source, in its own table? The
 * one shape that creates a brand-new permission scope (vs. attaching a row to an existing one).
 * Both halves matter: a derived-source row (a Task carrying its Thought's scope) can share the
 * root's id without being a root, and a row pointing at a same-id record in another table is an
 * attach, not a birth.
 */
function isScopeRootInsert(table: Table<any>, insertObj: any, sourceId: string, sourceTable: string): boolean {
  return sourceId === insertObj.id && sourceTable === table.name;
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
      // PURE default: a root shared record is its own permission source. Column defaults run
      // wherever the insert is assembled — including the browser's client `Transaction` queue,
      // which has NO db driver — so the default must never touch the db. The owner-grant
      // bootstrap that used to live here is a server-side act: see `onAfterInsert` below.
      defaultValue:
        permissionSourceDefaultValue ?? (async (table, insertObj) => new Reference(table.name, insertObj.id)),
      // ROW-INJECTION GUARD (the unguarded-insert hole): db.insert had no capability check, and
      // supplying `permissionSource` explicitly skips the self-scope default above — so any
      // authenticated caller could attach a row into ANY resource's permission scope. Require the
      // caller to hold write+ on the referenced source for every non-system insert. A SCOPE-ROOT
      // insert (the row is its own permission source, in its own table) is exempt: it creates a
      // brand-new scope rather than attaching to one, and its owner grant cannot exist yet — it
      // is minted in `onAfterInsert`, only once the row's insert actually succeeds (so an insert
      // refused here or failed at the DML, e.g. a duplicate id aimed at an existing resource, can
      // never leave a grant behind). A derived source (e.g. a Task inheriting its Thought's
      // scope) passes only for a caller who can write that Thought.
      onBeforeInsert: async (table, insertObj, runAsSystem) => {
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

        if (isScopeRootInsert(table, insertObj, sourceId, sourceTable)) {
          return;
        }

        if (!(await callerHasWriteAccess(sourceId, sourceTable))) {
          throw new RecordAccessError(
            `User does not have write access to the permission source (${sourceTable}:${sourceId})`
          );
        }
      },
      // OWNER-GRANT BOOTSTRAP (server-side, post-DML): a scope root's creator gets an `owner`
      // grant the moment the row lands. The grant is PLATFORM-CONFERRED, not something the user
      // grants themselves — written as SYSTEM, which is both correct and self-authorizing
      // (AccessGrantTable.onBeforeInsert's escalation gate short-circuits on runAsSystem; a
      // caller-context write would be refused for having no pre-existing admin grant). This hook
      // only ever runs inside `Db.insert` — the server — so the browser assembling the insert
      // (client Transaction defaults) needs no db, and it runs AFTER the DML, so no failed insert
      // can mint a grant. Runs for system-context creations too (parity with the old bootstrap):
      // server flows creating roots as system still confer the session user's owner grant.
      onAfterInsert: async (table, insertObj) => {
        if (skipAccessGrantsEnabled()) {
          return;
        }

        const permissionSource = insertObj.permissionSource as Reference<any> | undefined;
        const sourceId = permissionSource?._id;
        const sourceTable = permissionSourceTableName ?? (insertObj as any).permissionSourceTable;
        if (!sourceId || !sourceTable || !isScopeRootInsert(table, insertObj, sourceId, sourceTable)) {
          return;
        }

        const user = new UserRepo().getUser();
        await getDbAsSystem<AccessGrant>().insert(tables.AccessGrant, {
          principal: new Reference(new UserTable().name, user.id),
          resource: new Reference(table.name, insertObj.id),
          resourceTable: table.name,
          accessLevel: 'owner',
        });
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
