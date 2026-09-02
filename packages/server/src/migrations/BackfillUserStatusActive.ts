import { Migration, QueryBuilderFactory, SourceRecordLoader, getDbAsSystem, tables as dbTables } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { UserStatus, tables } from '@proteinjs/user';

/**
 * Retires the legacy null-status state on `user.status`: rows predating the column read NULL,
 * which every gate treats as active (only an explicit 'deactivated' is refused) — but the
 * stored state was dishonest: the admin user table showed no standing for exactly the accounts
 * that ARE active (founder admin review, v1.22), and a query by `status = 'active'` could not
 * find them. New rows default 'active' at insert, so once this runs the dual representation is
 * gone: storage says what the gates always read.
 *
 * No audit rows: the SetUserStatus audit trail records status CHANGES; this writes the same
 * standing the gates already read — a representation fix, not a standing change.
 *
 * Idempotent by shape: only NULL-status rows match, and each write makes the row unmatchable.
 * Writes ride the ORM (system path) so serialization and table watchers have one owner — an
 * 'active' write is not a deactivation, so the session-killing watcher stays quiet.
 */
export class BackfillUserStatusActive implements SourceRecordLoader<Migration> {
  table = dbTables.Migration;
  record = {
    id: 'dbf1b4a3-edaa-4974-9a33-f1ce2c3c6985',
    description: `Backfill user.status 'active' onto rows predating the status column (the standing every gate already reads)`,
    run: async () => {
      const logger = new Logger({ name: this.constructor.name });
      const db = getDbAsSystem();
      const qb = new QueryBuilderFactory()
        .getQueryBuilder(tables.User)
        .condition({ field: 'status', operator: 'IS NULL' });
      const rows = await db.query(tables.User, qb);

      let backfilled = 0;
      for (const row of rows) {
        await db.update(tables.User, { id: row.id, status: 'active' as UserStatus });
        backfilled++;
      }

      logger.info({ message: `Backfilled user.status`, obj: { backfilled } });
      return { backfilled };
    },
  };
}
