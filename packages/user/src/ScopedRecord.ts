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

export const getScopedDbAsSystem = <R extends ScopedRecord = ScopedRecord>() => new Db<R>(undefined, undefined, true);

const getScopedRecordColumns = (accessibleScopes: string[] = []) => {
  return {
    scope: new StringColumn('scope', {
      defaultValue: async () => new UserRepo().getUser().id,
      forceDefaultValue: true,
      addToQuery: async (qb, runAsSystem) => {
        if (!runAsSystem) {
          qb.condition({
            field: 'scope',
            operator: 'IN',
            value: [new UserRepo().getUser().id, ...accessibleScopes],
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
