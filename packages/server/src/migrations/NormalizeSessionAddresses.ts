import { Db, Migration, RecordIterator, SourceRecordLoader, getDbAsSystem, tables as dbTables } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { tables } from '@proteinjs/user';

/**
 * Brings every session row's address to the account row's: lowercased. Until `establishSession`
 * bound the address lowercased, the login route bound it AS TYPED, so a sign-in typed with a
 * capital letter left a session row whose `userEmail` no account row equals — and every
 * by-account session end (`AccountSessions`: a password reset or change, an address change, a
 * deactivation, a machine credential's rotation) matches the account's lowercased address
 * exactly, so those sessions outlived the credential they were opened with, for the rest of
 * their sixty-day idle life. The session cache lowercases on every read, so they kept working.
 *
 * The matchers stay exact equalities on purpose: the query builder has no function expressions
 * (`LOWER(user_email) = ?` is not a condition it can build), and a raw-DML delete would bypass
 * the `Db.delete` watchers that disconnect a killed session's live sockets. The session table has
 * no index on `user_email` either way — a scan in both shapes — so the data is brought to the
 * invariant once, here, and the one minting door keeps it there.
 *
 * Idempotent by shape: only rows whose address differs from its lowercase match, and the write
 * makes a row unmatchable. Writes ride the ORM (system path) so the table's watchers see them as
 * any other write (the socket watcher acts on deletes only — nobody is disconnected). A row
 * minted as typed by a pod of the previous release while this ran is the one case this cannot
 * reach: the deploy Job runs before the rollout advances, so the old pods still mint for the
 * minutes until they are replaced.
 */
export class NormalizeSessionAddresses implements SourceRecordLoader<Migration> {
  table = dbTables.Migration;
  record = {
    id: 'c4e1a7d2-3b58-4f0e-9a6c-2d7f8e1b5a90',
    description: `Lowercase every session row's address so the by-account session kills can find every session`,
    estimate: async () => {
      if (!(await this.tableExists())) {
        return { units: 0, unit: 'rows', note: 'no session table yet' };
      }

      const counted = (await Db.getDefaultDbDriver().runQuery(() => ({
        sql: `SELECT COUNT(*) AS pending FROM ${tables.Session.name} WHERE user_email != LOWER(user_email)`,
      }))) as unknown as Array<{ pending: number | string }>;
      return { units: Number(counted[0]?.pending ?? 0), unit: 'rows' };
    },
    run: async () => {
      const logger = new Logger({ name: this.constructor.name });
      const db = getDbAsSystem();
      let normalized = 0;
      for await (const session of new RecordIterator(tables.Session, {}, 100, db)) {
        // A row with no address (none is minted so; the column is written at every set) matches no
        // account and no kill either way — nothing to bring over, and nothing to throw on.
        const address = session.userEmail?.toLowerCase();
        if (!address || session.userEmail === address) {
          continue;
        }

        await db.update(tables.Session, { id: session.id, userEmail: address });
        normalized++;
      }

      logger.info({ message: `Normalized session addresses`, obj: { normalized } });
      return { normalized };
    },
  };

  private async tableExists(): Promise<boolean> {
    const rows = await Db.getDefaultDbDriver().runQuery(() => ({
      sql: `SELECT table_name FROM information_schema.tables WHERE table_name = '${tables.Session.name}'`,
    }));
    return rows.length > 0;
  }
}
