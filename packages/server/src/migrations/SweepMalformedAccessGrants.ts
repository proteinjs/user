import {
  getDbAsSystem,
  getTables,
  Migration,
  QueryBuilder,
  QueryBuilderFactory,
  Record,
  RecordIterator,
  SourceRecordLoader,
  Table,
  tables as dbTables,
} from '@proteinjs/db';
import { AccessGrant, tables as userTables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';

/** One access_grant row as the sweep logs and reports it. */
export interface AccessGrantSweepRow {
  id: string;
  resourceTable?: string;
  accessLevel: AccessGrant['accessLevel'];
  created?: string;
}

/** A well-formed grant whose principal or resource id no longer resolves to a row (report only). */
export interface DanglingAccessGrantRow extends AccessGrantSweepRow {
  principal?: string;
  resource?: string;
  reason: 'principal missing' | 'resource missing' | 'resource table not registered';
}

export interface SweepMalformedAccessGrantsResult {
  /** Rows on the invariant's exact complement (NULL principal or NULL resource) — deleted unless `dryRun`. */
  malformed: number;
  rows: AccessGrantSweepRow[];
  dryRun: boolean;
}

export interface DanglingAccessGrantsReport {
  danglingPrincipal: number;
  danglingResource: number;
  rows: DanglingAccessGrantRow[];
}

/**
 * ONE-TIME SWEEP of malformed access_grant residue — rows whose `principal` or `resource`
 * reference is NULL. The AccessGrant well-formedness invariant (`AccessGrantTable.assertWellFormed`)
 * now refuses that shape at insert, and the session-less scope-root bootstrap no longer mints it;
 * this migration clears what the two producers left behind before the fix (the test environment
 * held one; app Deploy to Test 32614670162 crashed on it).
 *
 * The sweep's predicate is the invariant's exact complement (`principal IS NULL OR resource IS
 * NULL`), and it rides BOTH the find and the delete — a well-formed row cannot be selected by the
 * statement that deletes, whatever the id list. Deletes go through the system Db by id, so the
 * registered after-delete watchers fire (a grantee's content_reference cleanup rides
 * `ContentReferenceAccessGrantTableWatcher`). Idempotent: a re-run finds nothing.
 *
 * DANGLING references are a separate class and are NOT deleted here: a well-formed grant whose
 * principal user or resource row was purged out from under it. Those are REPORTED (log +
 * migration output) so the purge paths that strand them can be named; a delete would be a
 * symptom patch on a producer this migration does not own.
 *
 * App-service/system-db path only — never raw Spanner.
 */
export class SweepMalformedAccessGrants implements SourceRecordLoader<Migration> {
  table = dbTables.Migration;
  record = {
    id: '2b7e4d0c-5f1a-4c3e-9b8d-6a2f1e0c7d45',
    description:
      'Sweep malformed access_grant rows (NULL principal or NULL resource — the well-formedness invariant’s complement); report dangling references, no delete.',
    run: async () => {
      const logger = new Logger({ name: SweepMalformedAccessGrants.name });
      // Dry-run pass first: every row the delete pass will touch is in the log before it goes.
      const dry = await this.sweep({ dryRun: true });
      const real = await this.sweep({ dryRun: false });
      const dangling = await this.reportDangling();
      const output = {
        malformed: real.malformed,
        malformedDryRun: dry.malformed,
        danglingPrincipal: dangling.danglingPrincipal,
        danglingResource: dangling.danglingResource,
        malformedRows: real.rows,
        danglingRows: dangling.rows,
      };
      logger.info({ message: 'SweepMalformedAccessGrants completed', obj: output });
      return output;
    },
  };

  /** Find (and unless `dryRun`, delete) every malformed grant. Each row is logged either way. */
  async sweep(options: { dryRun: boolean }): Promise<SweepMalformedAccessGrantsResult> {
    const { dryRun } = options;
    const logger = new Logger({ name: SweepMalformedAccessGrants.name });
    const db = getDbAsSystem<AccessGrant>();

    const findQb = this.malformedPredicate(new QueryBuilderFactory().getQueryBuilder(userTables.AccessGrant)).sort([
      { field: 'created' },
    ]);
    const malformed = await db.query(userTables.AccessGrant, findQb);
    const rows = malformed.map((grant) => this.toRow(grant));
    for (const row of rows) {
      logger.info({
        message: dryRun ? 'Malformed access_grant (dry run)' : 'Deleting malformed access_grant',
        obj: row,
      });
    }

    if (!dryRun) {
      for (const grant of malformed) {
        // By id, with the predicate bound: the statement that deletes cannot select a well-formed row.
        const deleteQb = this.malformedPredicate(
          new QueryBuilderFactory().getQueryBuilder(userTables.AccessGrant, { id: grant.id })
        );
        await db.delete(userTables.AccessGrant, deleteQb);
      }
    }

    const result = { malformed: rows.length, rows, dryRun };
    logger.info({ message: dryRun ? 'Sweep dry run' : 'Sweep pass', obj: { malformed: rows.length, dryRun } });
    return result;
  }

  /**
   * Report-only scan for well-formed grants whose principal or resource row no longer exists —
   * the purged-user / purged-resource class. Nothing is deleted.
   */
  async reportDangling(): Promise<DanglingAccessGrantsReport> {
    const logger = new Logger({ name: SweepMalformedAccessGrants.name });
    const db = getDbAsSystem<AccessGrant>();

    // One pass over the table, collecting the ids to resolve per referenced table.
    const grants: AccessGrant[] = [];
    const principalIds = new Set<string>();
    const resourceIdsByTable = new Map<string, Set<string>>();
    for await (const grant of new RecordIterator<AccessGrant>(userTables.AccessGrant, {}, 200, db)) {
      const principalId = grant.principal?._id;
      const resourceId = grant.resource?._id;
      if (!principalId || !resourceId) {
        continue; // the malformed class — `sweep` owns it
      }
      grants.push(grant);
      principalIds.add(principalId);
      const resourceTable = grant.resourceTable ?? grant.resource._table;
      if (!resourceIdsByTable.has(resourceTable)) {
        resourceIdsByTable.set(resourceTable, new Set());
      }
      resourceIdsByTable.get(resourceTable)!.add(resourceId);
    }

    const existingPrincipals = await this.existingIds(userTables.User, principalIds);
    const existingResourcesByTable = new Map<string, Set<string> | null>();
    for (const tableName of Array.from(resourceIdsByTable.keys())) {
      const table = getTables().find((candidate) => candidate.name === tableName);
      existingResourcesByTable.set(
        tableName,
        table ? await this.existingIds(table, resourceIdsByTable.get(tableName)!) : null
      );
    }

    const report: DanglingAccessGrantsReport = { danglingPrincipal: 0, danglingResource: 0, rows: [] };
    for (const grant of grants) {
      const resourceTable = grant.resourceTable ?? grant.resource._table;
      const existingResources = existingResourcesByTable.get(resourceTable);
      let reason: DanglingAccessGrantRow['reason'] | undefined;
      if (!existingPrincipals.has(grant.principal._id!)) {
        reason = 'principal missing';
        report.danglingPrincipal++;
      } else if (existingResources === null) {
        reason = 'resource table not registered';
        report.danglingResource++;
      } else if (!existingResources!.has(grant.resource._id!)) {
        reason = 'resource missing';
        report.danglingResource++;
      }
      if (!reason) {
        continue;
      }
      const row: DanglingAccessGrantRow = {
        ...this.toRow(grant),
        principal: grant.principal._id,
        resource: grant.resource._id,
        reason,
      };
      report.rows.push(row);
      logger.warn({ message: 'Dangling access_grant (report only, not deleted)', obj: row });
    }

    logger.info({
      message: 'Dangling access_grant report',
      obj: { danglingPrincipal: report.danglingPrincipal, danglingResource: report.danglingResource },
    });
    return report;
  }

  /** The well-formedness invariant's exact complement: a NULL principal or a NULL resource. */
  private malformedPredicate(qb: QueryBuilder<AccessGrant>): QueryBuilder<AccessGrant> {
    return qb.or([
      { field: 'principal', operator: 'IS NULL' },
      { field: 'resource', operator: 'IS NULL' },
    ]);
  }

  /** Which of `ids` exist in `table`, resolved as system in bounded IN chunks. */
  private async existingIds(table: Table<any>, ids: Set<string>): Promise<Set<string>> {
    const existing = new Set<string>();
    const all = Array.from(ids);
    const chunkSize = 200;
    for (let start = 0; start < all.length; start += chunkSize) {
      const chunk = all.slice(start, start + chunkSize);
      const qb = new QueryBuilderFactory()
        .getQueryBuilder(table)
        .select({ fields: ['id'] })
        .condition({ field: 'id', operator: 'IN', value: chunk });
      const found = (await getDbAsSystem().query(table, qb)) as Record[];
      for (const record of found) {
        existing.add(record.id);
      }
    }
    return existing;
  }

  private toRow(grant: AccessGrant): AccessGrantSweepRow {
    return {
      id: grant.id,
      resourceTable: grant.resourceTable,
      accessLevel: grant.accessLevel,
      created: grant.created?.toISOString(),
    };
  }
}
