import {
  Columns,
  StringColumn,
  Record,
  withRecordColumns,
  getDb,
  Table,
  getColumnByName,
  getTables,
  Db,
} from '@proteinjs/db';
import { UserRepo } from './UserRepo';

export interface ScopedRecord extends Record {
  scope: string;
}

export const getScopedDb = getDb<ScopedRecord>;

export const getScopedDbAsSystem = <R extends ScopedRecord = ScopedRecord>() =>
  new Db<R>(undefined, undefined, undefined, true);

/**
 * The current user's id, for use as a scope value. Throws a NAMED error when there is no user in
 * the current context: `UserRepo.getUser()` degrades to `{ roles: [] }` when the session storage
 * has no data (e.g. a call outside a request's async context), and silently threading that
 * `undefined` into a scoped query produces a driver-level cryptic failure (Spanner:
 * "Value of type undefined not recognized" from `scope IN UNNEST([undefined])`) — hours of
 * misdirection, observed repeatedly in test-order sensitivity debugging. Fail loudly at the seam
 * that knows what went wrong instead.
 */
const requireScopeUserId = (operation: string): string => {
  const userId = new UserRepo().getUser().id;
  if (!userId) {
    throw new Error(
      `No user in scope context for a scoped ${operation}: Session data has no user in the current ` +
        `async context. Run as system for system-owned work, or ensure the caller runs within a ` +
        `session-seeded context (request handler / test environment).`
    );
  }
  return userId;
};

const getScopedRecordColumns = (accessibleScopes: string[] = []) => {
  return {
    scope: new StringColumn('scope', {
      defaultValue: async () => requireScopeUserId('write'),
      forceDefaultValue: (runAsSystem) => !runAsSystem,
      addToQuery: async (qb, runAsSystem) => {
        if (!runAsSystem) {
          qb.condition({
            field: 'scope',
            operator: 'IN',
            value: [requireScopeUserId('query'), ...accessibleScopes],
          });
        }
      },
      ui: { hidden: true },
    }),
  };
};

export function getScopedTables() {
  return getTables<ScopedRecord>().filter((table) => isScopedTable(table));
}

export function isScopedTable(table: Table<any>) {
  const scopeColumn = getColumnByName(table, getScopedRecordColumns().scope.name);
  return !!scopeColumn;
}

/**
 * Wrapper function to add default ScopedRecord columns to your table's columns.
 *
 * Note: using this requires an explicit dependency on moment@2.29.4 in your package (since transient dependencies are brittle by typescript's standards)
 *
 * @param columns your columns
 * @returns recordColumns & sourceRecordColumns & your columns
 */
export function withScopedRecordColumns<T extends ScopedRecord>(
  columns: Columns<Omit<T, keyof ScopedRecord>>,
  accessibleScopes?: string[]
): Columns<ScopedRecord> & Columns<Omit<T, keyof ScopedRecord>> {
  return Object.assign(
    Object.assign({}, getScopedRecordColumns(accessibleScopes)),
    withRecordColumns<Record>(columns) as any
  );
}

/**
 * Adds the `scope` column as the first column to the provided index.
 *
 * @param args Index to create
 * @returns Index with `scope` column added first
 */
export function createScopedIndex<T extends ScopedRecord>(args: {
  columns: (keyof T)[];
  name?: string;
}): { columns: (keyof T)[]; name?: string } {
  if (args.columns.includes('scope')) {
    return args;
  }

  return { columns: ['scope', ...args.columns], name: args.name };
}
