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
  QueryBuilder,
  Condition,
  Reference,
} from '@proteinjs/db';
import { UserRepo } from './UserRepo';

export interface ScopedRecord extends Record {
  scope: string;
}

export type ScopedRecordOptions<T extends ScopedRecord> = {
  inheritScope?: {
    // Must be of type Reference
    parentColumn: { [K in keyof T]: T[K] extends Reference<infer U> | undefined ? K : never }[keyof T];
  };
  accessibleScopes: string[];
  useDefaultScope: boolean;
};

export const getScopedDb = getDb<ScopedRecord>;

export const getScopedDbAsSystem = <R extends ScopedRecord = ScopedRecord>() =>
  new Db<R>(undefined, undefined, undefined, true);

const getScopedRecordColumns = <T extends ScopedRecord>(options?: ScopedRecordOptions<T>) => {
  return {
    scope: new StringColumn('scope', {
      defaultValue: async () => new UserRepo().getUser().id,
      forceDefaultValue: (runAsSystem) => (runAsSystem ? false : !!options?.useDefaultScope),
      addToQuery: async (qb, runAsSystem) => {
        const { accessibleScopes, inheritScope } = options ?? {};

        if (runAsSystem) {
          return;
        }

        const userId = new UserRepo().getUser().id;
        const scopeValues = [userId, ...(accessibleScopes ?? [])];

        if (inheritScope && inheritScope.parentColumn) {
          const parentColumn = inheritScope.parentColumn;

          qb.or([
            {
              field: 'scope',
              operator: 'IN',
              value: scopeValues,
            },
            createParentScopeCondition(qb, parentColumn, scopeValues),
          ]);

          return;
        } else {
          qb.condition({
            field: 'scope',
            operator: 'IN',
            value: scopeValues,
          });
        }
      },
      ui: { hidden: true },
    }),
  };
};

function createParentScopeCondition<T extends ScopedRecord>(
  qb: QueryBuilder<T>,
  parentColumn: keyof T,
  scopeValues: string[]
): QueryBuilder<T> {
  const conditions: Condition<T>[] = [
    {
      field: parentColumn,
      operator: 'IS NOT NULL',
    },
  ];

  if (scopeValues.length > 0) {
    const subQuery = new QueryBuilder(qb.tableName);

    subQuery.select({
      fields: ['id'],
    });

    subQuery.condition({
      field: 'scope',
      operator: 'IN',
      value: scopeValues,
    });

    conditions.push({
      field: parentColumn,
      operator: 'IN',
      value: subQuery,
    });
  }

  return qb.and(conditions);
}
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
 * @param options ScopedRecordOptions
 * @returns recordColumns & sourceRecordColumns & your columns
 */
export function withScopedRecordColumns<T extends ScopedRecord>(
  columns: Columns<Omit<T, keyof ScopedRecord>>,
  options: Partial<ScopedRecordOptions<T>>
): Columns<ScopedRecord> & Columns<Omit<T, keyof ScopedRecord>> {
  const defaultOpts: ScopedRecordOptions<T> = {
    accessibleScopes: [],
    useDefaultScope: true,
  };

  return Object.assign(
    Object.assign({}, getScopedRecordColumns(Object.assign({}, defaultOpts, options))),
    withRecordColumns<Record>(columns) as any
  );
}
