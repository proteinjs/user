import { Db, Migration, SourceRecordLoader, getDbAsSystem, tables as dbTables } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';

/**
 * Cutover for `user.roles`: comma-separated free text (legacy `roles` STRING(255) column) → the
 * typed array `role_list` column. Spanner cannot retype a column in place, so the change is
 * three-part: the new column (added by schema sync at boot), THIS backfill, and the code cutover
 * (`UserTable.roles` now reads/writes `role_list`; the legacy column stays physically present but
 * undeclared).
 *
 * Reads the legacy column via raw SQL — it is no longer in the table definition, so the ORM
 * cannot see it — and writes through the ORM so `role_list` serialization has exactly one owner.
 * Parsing normalizes what free text accumulated: trim, drop empties, dedupe.
 *
 * Idempotent and safe everywhere: rows already carrying a `role_list` value are skipped (a
 * re-run cannot clobber a post-cutover grant), and a database whose user table never had the
 * legacy column (fresh installs) is a clean no-op via the information_schema check.
 */
export class BackfillUserRolesArray implements SourceRecordLoader<Migration> {
  table = dbTables.Migration;
  record = {
    id: '65916145-71d3-49a1-bd07-154de33195f6',
    description: 'Backfill user.role_list (typed array) from the legacy comma-separated roles column',
    run: async () => {
      const logger = new Logger({ name: this.constructor.name });
      const dbDriver = Db.getDefaultDbDriver();
      const userTableName = tables.User.name;

      const legacyColumn = await dbDriver.runQuery(() => ({
        sql:
          `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_name = '${userTableName}' AND column_name = 'roles'`,
      }));
      if (legacyColumn.length === 0) {
        logger.info({ message: `No legacy roles column on ${userTableName}; nothing to backfill` });
        return { backfilled: 0 };
      }

      const rows = (await dbDriver.runQuery(() => ({
        sql:
          `SELECT id, roles FROM ${userTableName} ` + `WHERE roles IS NOT NULL AND roles != '' AND role_list IS NULL`,
      }))) as unknown as Array<{ id: string; roles: string }>;

      const db = getDbAsSystem();
      let backfilled = 0;
      try {
        for (const row of rows) {
          const roles = Array.from(
            new Set(
              row.roles
                .split(',')
                .map((role) => role.trim())
                .filter((role) => role.length > 0)
            )
          );
          await db.update(tables.User, { id: row.id, roles });
          backfilled++;
        }

        logger.info({ message: `Backfilled user roles`, obj: { backfilled } });
        return { backfilled };
      } catch (error) {
        logger.error({ message: `Error backfilling user roles`, obj: { error } });
        throw error;
      }
    },
  };
}
