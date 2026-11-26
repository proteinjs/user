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
  getDefaultTransactionContextFactory,
  getTables,
  withRecordColumns,
  Reference,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
} from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';

import { AccessGrant, AccessGrantTable } from './tables/AccessGrantTable';
import { NoPrincipalError } from './NoPrincipalError';
import { UserRepo } from './UserRepo';
import { UserTable } from './tables/UserTable';
import { tables } from './tables/tables';

/** Levels that satisfy a WRITE capability on a permission source (read ⊂ write ⊂ admin ⊂ owner). */
const WRITE_ACCESS_LEVELS: AccessGrant['accessLevel'][] = ['write', 'admin', 'owner'];
/** Levels that satisfy a DELETE of a row, held on its permission source. */
const DELETE_ACCESS_LEVELS: AccessGrant['accessLevel'][] = ['admin', 'owner'];

/**
 * The caller's principal for a grant-scoped `operation` on `table`: the session user's id. With
 * access grants enforced there is no grant-scoped operation without one — a context with no session
 * user (a background executor, a boot- or deploy-time migration, a socket event callback, a startup
 * task's timer) refuses HERE, by name, instead of threading `undefined` into the grant subquery and
 * failing in the query builder with a message that names neither the table nor the caller
 * (`Must not pass in undefined for value in condition … principal` — a stack-walk to attribute,
 * every time). Only reached with grants enforced and outside a system
 * db: every caller below checks both first, so a session user and a skipped-grants run see no change.
 */
function requirePrincipal(table: string, operation: string): string {
  const principal = new UserRepo().getUser().id;
  if (!principal) {
    throw new NoPrincipalError({ table, operation });
  }
  return principal;
}

/**
 * Does the CURRENT caller hold a write-or-greater grant on the given permission source? Queries
 * the caller's own grants directly as SYSTEM — never through the read-scoped `resource.get()` that
 * let a no-access caller's undefined fetch skip the check (the escalation-hole shape). This is the
 * one owner for "can this caller write into this permission scope", shared by the insert guard,
 * the update's own check of a source it names, and the zero-row write refusal below. `on` names
 * the table and operation being guarded, for the no-principal refusal.
 */
async function callerHasWriteAccess(
  permissionSourceId: string,
  permissionSourceTableName: string,
  on: { table: string; operation: string }
): Promise<boolean> {
  const principal = requirePrincipal(on.table, on.operation);
  const memo = transactionGrantMemo();
  const key = `${principal}|${permissionSourceTableName}|${permissionSourceId}`;
  const proven = memo?.get(key);
  if (proven !== undefined) {
    return proven;
  }
  const qb = new QueryBuilder(tables.AccessGrant.name);
  qb.condition({ field: 'principal', operator: '=', value: principal });
  qb.condition({ field: 'resource', operator: '=', value: permissionSourceId });
  qb.condition({ field: 'resourceTable', operator: '=', value: permissionSourceTableName });
  qb.condition({ field: 'accessLevel', operator: 'IN', value: WRITE_ACCESS_LEVELS });
  const grants = await getDbAsSystem<AccessGrant>().query(tables.AccessGrant, qb);
  const held = grants.length > 0;
  memo?.set(key, held);
  return held;
}

/**
 * The permission sources, among the rows of `sourceTableName`, on which the CURRENT caller holds one
 * of `levels`: the grants subquery the row rule is written with (`addToQuery`), and the one an
 * update's own conditions are narrowed with when it names another source for a row that is its own
 * (`onBeforeUpdate`). `on` names the table and operation asked, for the no-principal refusal.
 */
function sourcesTheCallerHolds(
  levels: AccessGrant['accessLevel'][],
  sourceTableName: string,
  on: { table: string; operation: string }
): QueryBuilder {
  const subQuery = new QueryBuilder(tables.AccessGrant.name);
  subQuery.select({
    fields: ['resource'],
  });

  subQuery.condition({
    field: 'principal',
    operator: '=',
    value: requirePrincipal(on.table, on.operation),
  });

  subQuery.condition({
    field: 'accessLevel',
    operator: 'IN',
    value: levels,
  });

  subQuery.condition({
    field: 'resourceTable',
    operator: '=',
    value: sourceTableName,
  });

  return subQuery;
}

/**
 * Does the CURRENT caller hold admin or owner on the given permission source? The caller's own
 * grants, read as SYSTEM, as {@link callerHasWriteAccess} reads them. Asked after a write that
 * matched nothing, to say why by name (`onZeroRowFilteredWrite`); the rule itself is in the
 * update's own conditions.
 */
async function callerHoldsAdminOrOwner(
  permissionSourceId: string,
  permissionSourceTableName: string,
  on: { table: string; operation: string }
): Promise<boolean> {
  const qb = new QueryBuilder(tables.AccessGrant.name);
  qb.condition({ field: 'principal', operator: '=', value: requirePrincipal(on.table, on.operation) });
  qb.condition({ field: 'resource', operator: '=', value: permissionSourceId });
  qb.condition({ field: 'resourceTable', operator: '=', value: permissionSourceTableName });
  qb.condition({ field: 'accessLevel', operator: 'IN', value: DELETE_ACCESS_LEVELS });
  return (await getDbAsSystem<AccessGrant>().query(tables.AccessGrant, qb)).length > 0;
}

/**
 * THE GRANTS ONE TRANSACTION HAS ALREADY PROVEN: {@link callerHasWriteAccess} is answered once per
 * (principal, permission source) inside a transaction and reused for every later row of the same
 * transaction — a transaction that attaches many rows to one scope (a document's whole subtree
 * written in one unit) asks the grant table once, not once per row. Inside a read-write transaction
 * every ask is a serial round trip, so the row count was the trip count. Keyed by the transaction's
 * own object, a memo lives exactly as long as its transaction and never crosses one (a WeakMap,
 * released with it). Outside a transaction nothing is memoized — every lone insert asks, as it
 * always has.
 *
 * The one window the memo opens: a grant revoked inside the same transaction, after it was proven,
 * is not asked again — the transaction's own earlier proof stands until it commits or aborts.
 */
const grantsProvenInTransaction = new WeakMap<object, Map<string, boolean>>();

/** The current transaction's memo, created on first use; undefined outside a transaction. */
function transactionGrantMemo(): Map<string, boolean> | undefined {
  const transaction = getDefaultTransactionContextFactory()?.getTransactionContext().currentTransaction;
  if (!transaction || typeof transaction !== 'object') {
    return undefined;
  }
  let memo = grantsProvenInTransaction.get(transaction);
  if (!memo) {
    memo = new Map();
    grantsProvenInTransaction.set(transaction, memo);
  }
  return memo;
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

        if (!(await callerHasWriteAccess(sourceId, sourceTable, { table: table.name, operation: 'insert' }))) {
          throw new RecordAccessError(
            `User does not have write access to the permission source (${sourceTable}:${sourceId})`
          );
        }
      },
      // A ROW IS MOVED BY A WRITER OF ITS NEW SOURCE (the update-side twin of the insert's check
      // above): an update that carries `permissionSource` moves the rows it selects into that
      // source's permission scope, so the caller holds write+ on the source it names, exactly as an
      // insert that names one does. The source's table is the one this table's rows take their
      // permission from (the value an insert stores), whatever table the payload's reference names.
      // The rows an update leaves are rows the caller can already write (`addToQuery` below). An
      // update that does not carry the field moves nothing and asks nothing; one that names the
      // source a row is already in asks the same question and is written for any writer of it. A
      // row keeps a source, named by a string id: a payload that carries the field with no id, or
      // with an id that is not a string, is refused, so the id asked about is the id stored.
      // System writes (migrations, server flows that re-home rows) are not asked. The question is
      // the insert's own (`callerHasWriteAccess`), with its memo.
      //
      // A PERSON'S UPDATE THAT NAMES A PERMISSION SOURCE NAMES ITS ROW BY ID: one row an update, the
      // row the database library tells this step (`rows.id`). An update that names its rows by a
      // builder, or by an object that holds no id, is refused.
      //
      // A ROW THAT IS ITS OWN PERMISSION SOURCE IS GIVEN ANOTHER BY A CALLER WHO HOLDS ADMIN OR OWNER
      // ON IT. Such a row is the root of a scope: its people reach it by the grants on it, and under
      // another source it answers to that source's grants. So an update that names another source
      // for the row it names adds to its own conditions: the row is the one it was told, and it is
      // not its own source, or the caller holds on it what a delete of it asks
      // (`DELETE_ACCESS_LEVELS`). The rule is part of the conditions the update's row is chosen by,
      // and a row the rule leaves out is not written. Where the update is one statement, the row is
      // asked and written at once; an update that also writes an encrypted column chooses its row
      // by a read under the same conditions and writes the row it read. The caller is told by name
      // where a write that matched nothing is explained (`onZeroRowFilteredWrite`). A row that
      // takes its permission from another row is a writer's to move, and an update that names the
      // row itself adds nothing. In a table whose rows take their permission from another table's
      // rows, no row is its own source: the first rule holds there and the second adds nothing.
      onBeforeUpdate: async (table, updateObj, runAsSystem, rows) => {
        if (runAsSystem || skipAccessGrantsEnabled()) {
          return;
        }

        const permissionSource = updateObj.permissionSource as Reference<any> | null | undefined;
        if (permissionSource === undefined) {
          return;
        }

        const sourceId = permissionSource?._id;
        const sourceTable = permissionSourceTableName ?? table.name;
        if (typeof sourceId !== 'string' || !sourceId) {
          throw new RecordAccessError(
            `A ${table.name} row keeps a permission source: an update that carries one names it by its id`
          );
        }

        if (!rows) {
          throw new Error(
            `A ${table.name} row's permission source is ruled on with the rows its update names: this needs a @proteinjs/db whose update hands a column's step its rows (\`UpdateRows\`)`
          );
        }

        if (rows.id === undefined) {
          throw new RecordAccessError(
            `A ${table.name} row is given a permission source by its id: an update that names its rows by a query carries none`
          );
        }

        if (!(await callerHasWriteAccess(sourceId, sourceTable, { table: table.name, operation: 'update' }))) {
          throw new RecordAccessError(
            `User does not have write access to the permission source (${sourceTable}:${sourceId})`
          );
        }

        if (sourceTable !== table.name || rows.id === sourceId) {
          return;
        }

        rows.conditions.condition({ field: 'id', operator: '=', value: rows.id });
        rows.conditions.or([
          { field: 'permissionSource', operator: '!=', value: rows.id },
          {
            field: 'permissionSource',
            operator: 'IN',
            value: sourcesTheCallerHolds(DELETE_ACCESS_LEVELS, sourceTable, { table: table.name, operation: 'update' }),
          },
        ]);
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
      //
      // NO SESSION USER (background executors, boot-time migrations — `getUser()` is `{}` there):
      // there is no creator to confer to. The old bootstrap minted a grant for nobody
      // (`principal = Reference('user', undefined)` → NULL, the malformed-grant class); the
      // AccessGrant table now refuses that row, and refusing AFTER the DML would strand the
      // creator with a landed row and a thrown insert. So the case is named here: no grant,
      // one warning — the root is system-only until a grant is conferred explicitly.
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
        if (!user.id) {
          new Logger({ name: 'SharedRecord' }).warn({
            message: 'Scope root created with no session user — no owner grant conferred',
            obj: { table: table.name, id: insertObj.id },
          });
          return;
        }

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
      onZeroRowFilteredWrite: async (table, id, operation, runAsSystem, record) => {
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

        if (!(await callerHasWriteAccess(sourceId, sourceTable, { table: table.name, operation }))) {
          throw new RecordAccessError(`User does not have ${operation} access to ${table.name}:${id}`);
        }

        // A write that named another permission source for a row that is its own, by a caller who
        // holds neither admin nor owner on the row: the update's own conditions left the row out
        // (`onBeforeUpdate`), and here the caller is told so by name.
        const named = (record?.permissionSource as Reference<any> | null | undefined)?._id;
        if (
          operation === 'write' &&
          (permissionSourceTableName ?? table.name) === table.name &&
          typeof named === 'string' &&
          named !== id &&
          sourceId === id &&
          !(await callerHoldsAdminOrOwner(id, table.name, { table: table.name, operation }))
        ) {
          throw new RecordAccessError(
            `User holds neither admin nor owner on ${table.name}:${id}: a row that is its own permission source is given another by a caller who holds one`
          );
        }
      },
      addToQuery: async (qb, runAsSystem, operation) => {
        if (runAsSystem || skipAccessGrantsEnabled()) {
          return;
        }

        const operationToLevel: globalThis.Record<typeof operation, AccessGrant['accessLevel'][]> = {
          read: ['read', 'write', 'admin', 'owner'],
          write: ['write', 'admin', 'owner'],
          delete: DELETE_ACCESS_LEVELS,
        };

        qb.condition({
          field: 'permissionSource',
          operator: 'IN',
          value: sourcesTheCallerHolds(operationToLevel[operation], permissionSourceTableName ?? qb.tableName, {
            table: qb.tableName,
            operation,
          }),
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
