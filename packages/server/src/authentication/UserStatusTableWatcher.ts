import { QueryBuilder, Table, TableWatcher, getDbAsSystem } from '@proteinjs/db';
import { User, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';

/**
 * The one owner of "deactivated ⇒ sessions die": any user-table update writing
 * `status: 'deactivated'` deletes the account's session rows (SocketIOSessionWatcher kicks the
 * live sockets on that delete). Because the writers all go through `Db.update` — the staff
 * toggle (SetUserStatus), account deletion, and the boot sync deactivating machine accounts
 * removed from source — this fires for every present and future deactivation path.
 *
 * The delete runs post-commit (`runAfterCommit`): a transactional status flip that rolls back
 * must not have killed sessions, and socket kicks must observe committed truth.
 */
export class UserStatusTableWatcher implements TableWatcher<User> {
  private logger = new Logger({ name: this.constructor.name });

  name(): string {
    return this.constructor.name;
  }

  table(): Table<User> {
    return tables.User;
  }

  async afterUpdate<T extends User>(recordUpdateCount: number, record: Partial<T>, qb: QueryBuilder<T>): Promise<void> {
    if (record.status !== 'deactivated' || recordUpdateCount === 0) {
      return;
    }

    if (!record.id) {
      // Every deactivation writer today updates by record id. A future query-based writer must
      // extend this watcher — surface it loudly instead of silently leaving sessions alive.
      this.logger.error({
        message: `Deactivation write without a record id — sessions NOT killed. Extend UserStatusTableWatcher for query-based status writers.`,
      });
      return;
    }

    const db = getDbAsSystem();
    await db.runAfterCommit(async () => {
      const user = await db.get(tables.User, { id: record.id });
      if (!user) {
        return; // row deleted since the flip — nothing to resolve sessions against
      }

      const deletedSessions = await db.delete(tables.Session, { userEmail: user.email });
      if (deletedSessions > 0) {
        this.logger.info({
          message: `Deactivation killed sessions`,
          obj: { email: user.email, sessions: deletedSessions },
        });
      }
    });
  }
}
