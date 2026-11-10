import {
  Db,
  Migration,
  QueryBuilderFactory,
  SourceRecordLoader,
  getDbAsSystem,
  tables as dbTables,
} from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { tables } from '@proteinjs/user';
import { MailedTokenValue } from '../authentication/MailedTokenValue';

/**
 * Digests every standing invite's token in place. An invite row minted before `Signup` stored
 * the digest holds the mailed token ITSELF, and `Signup.lookupInvite` now finds a row by the
 * digest of what the link carries (`MailedTokenValue`) — so without this, every invite link
 * mailed before the change would answer "no longer valid" while the admin's list showed the
 * invite standing. Each stored value becomes its SHA-256 (the digest the lookup computes for
 * the presented token), so every standing link keeps working and nothing is re-sent.
 *
 * A stored token and a stored digest share one shape (64 hex characters), so this cannot be
 * idempotent by shape: the whole pass commits in ONE transaction (a failure rolls every row
 * back and the ledger's retry starts from the same rows), and the migration ledger runs it
 * once. A row an old pod minted raw while the rollout was still replacing it — the deploy Job
 * runs before the rollout advances — is the one row this cannot reach; the admin re-sends that
 * one invite.
 */
export class DigestStandingInviteTokens implements SourceRecordLoader<Migration> {
  table = dbTables.Migration;
  record = {
    id: '7d2f9b61-0c4e-4a83-b5d7-9e3a6c1f0b24',
    description: `Store every standing invite token as its digest, so the links mailed before the digest-at-rest change keep working`,
    estimate: async () => {
      if (!(await this.tableExists())) {
        return { units: 0, unit: 'rows', note: 'no invite table yet' };
      }

      const counted = (await Db.getDefaultDbDriver().runQuery(() => ({
        sql: `SELECT COUNT(*) AS pending FROM ${tables.Invite.name} WHERE token IS NOT NULL`,
      }))) as unknown as Array<{ pending: number | string }>;
      return { units: Number(counted[0]?.pending ?? 0), unit: 'rows' };
    },
    run: async () => {
      const logger = new Logger({ name: this.constructor.name });
      const db = getDbAsSystem();
      const standing = new QueryBuilderFactory()
        .getQueryBuilder(tables.Invite)
        .condition({ field: 'token', operator: 'IS NOT NULL' });
      let digested = 0;
      await db.runTransaction(async () => {
        for (const invite of await db.query(tables.Invite, standing)) {
          await db.update(tables.Invite, { id: invite.id, token: MailedTokenValue.digest(invite.token as string) });
          digested++;
        }
      });

      logger.info({ message: `Digested standing invite tokens`, obj: { digested } });
      return { digested };
    },
  };

  private async tableExists(): Promise<boolean> {
    const rows = await Db.getDefaultDbDriver().runQuery(() => ({
      sql: `SELECT table_name FROM information_schema.tables WHERE table_name = '${tables.Invite.name}'`,
    }));
    return rows.length > 0;
  }
}
