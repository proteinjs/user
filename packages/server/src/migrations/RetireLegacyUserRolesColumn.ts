import { Db, Migration, SourceRecordLoader, tables as dbTables } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';

/**
 * Retires the legacy `user.roles` text column's data. The cutover to the typed `role_list` array
 * (BackfillUserRolesArray) left the old comma-text column physically present and undeclared, its
 * cells intact on every pre-cutover row: a stored key that is also the property's name (`roles`),
 * riding every read of the table. The row reader seats a cell by its declared column name alone
 * (@proteinjs/db ≥ 1.55.0), so the cell is inert — but data no declared column owns has no
 * business on the row. This NULLs it wherever the typed column already carries the roles, or the
 * legacy cell holds nothing to carry (the empty string a pre-cutover signup wrote).
 *
 * Never a legacy value the backfill has not consumed: a row with legacy text and no `role_list`
 * is left for BackfillUserRolesArray — this migration cannot run ahead of it by construction.
 *
 * Idempotent by shape: a NULLed cell no longer matches. Automated (the deploy-gated series); the
 * column itself goes in a later `manual` migration (a destructive contraction), once every
 * environment reads zero legacy cells. Raw SQL through the driver on both sides, as the backfill
 * reads it: the column is undeclared, so the ORM neither reads nor writes it. A database whose
 * user table never had the column (a fresh install) is a clean no-op.
 */
export class RetireLegacyUserRolesColumn implements SourceRecordLoader<Migration> {
  table = dbTables.Migration;
  record = {
    id: '2f6c0b9e-9c7a-4e0d-8f1b-5a3d7c2e9b41',
    description: `Retire the legacy comma-text user.roles column's cells once role_list carries the roles`,
    estimate: async () => {
      if (!(await this.legacyColumnExists())) {
        return { units: 0, unit: 'rows', note: 'no legacy roles column on the user table' };
      }

      const counted = (await Db.getDefaultDbDriver().runQuery(() => ({
        sql: `SELECT COUNT(*) AS pending FROM ${tables.User.name} WHERE ${this.retirableCells()}`,
      }))) as unknown as Array<{ pending: number | string }>;
      return { units: Number(counted[0]?.pending ?? 0), unit: 'rows' };
    },
    run: async () => {
      const logger = new Logger({ name: this.constructor.name });
      if (!(await this.legacyColumnExists())) {
        logger.info({ message: `No legacy roles column on ${tables.User.name}; nothing to retire` });
        return { retired: 0 };
      }

      const retired = await Db.getDefaultDbDriver().runDml(() => ({
        sql: `UPDATE ${tables.User.name} SET roles = NULL WHERE ${this.retirableCells()}`,
      }));
      logger.info({ message: `Retired legacy user roles cells`, obj: { retired } });
      return { retired };
    },
  };

  /** The cells this migration may NULL: a legacy value the typed column already carries, or nothing at all. */
  private retirableCells(): string {
    return `roles IS NOT NULL AND (role_list IS NOT NULL OR roles = '')`;
  }

  private async legacyColumnExists(): Promise<boolean> {
    const legacyColumn = await Db.getDefaultDbDriver().runQuery(() => ({
      sql:
        `SELECT column_name FROM information_schema.columns ` +
        `WHERE table_name = '${tables.User.name}' AND column_name = 'roles'`,
    }));
    return legacyColumn.length > 0;
  }
}
