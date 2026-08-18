import moment, { Moment } from 'moment';
import { Db, QueryBuilderFactory, Reference, getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';
import {
  AccessGrant,
  AccountDeletion as AccountDeletionRecord,
  AccountDeletionService,
  ManifestGrant,
  User,
  UserRepo,
  tables,
} from '@proteinjs/user';
import { DefaultAdminCredentials } from '../authentication/DefaultAdminCredentials';
import { PasswordHasher } from '../authentication/PasswordHasher';
import { AccountDeletionEmails } from '../emails/AccountDeletionEmails';
import { SetUserStatus } from './SetUserStatus';

/** IN-list chunk size for grant enumeration/revocation (the Db.ts IN-chunk precedent). */
const GRANT_CHUNK_SIZE = 100;

/**
 * Deactivation ("gone right away") + cancel-by-login — the synchronous half of archive-then-purge.
 * The purge walker (flow-server) owns erasure after the grace window; this service owns entering
 * and leaving the deactivated state, driven by the `account_deletion` manifest row.
 *
 * Deliberately NOT deactivation's job: the user's own content_reference/content_seen/pins/
 * notifications — all scoped to the locked-out user, invisible behind the auth gate, purged by
 * the walker. Leaving them preserves watermarks and pins exactly for cancel-restore.
 */
export class AccountDeletion implements AccountDeletionService {
  /** Any authenticated user — the call acts only on the session user (re-auth inside). */
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      allUsers: true,
    },
  };
  private logger = new Logger({ name: this.constructor.name });

  /**
   * §3.3 — seven steps, each idempotent; a re-call after a partial failure resumes from the
   * stored manifest. The caller's sessions die last, so the response is the last authenticated
   * exchange.
   */
  async requestDeletion(password: string): Promise<{ purgeAfter: Moment }> {
    // 1. Re-auth — a miss throws with nothing written.
    const user = await this.reauthenticateSessionUser(password);
    const db = getDbAsSystem();

    // 2. Resume check: an existing row means a prior call crashed mid-flight — resume with the
    // STORED manifest, never re-enumerate (after a partial revocation the live grants
    // under-count; rebuilding would clobber the manifest with the shrunken set).
    let deletion = await db.get(tables.AccountDeletion, { userId: user.id });

    // 3. Enumerate + persist — the manifest is durable BEFORE any mutation.
    if (!deletion) {
      deletion = await this.createDeletionManifest(db, user);
    }

    // 4. Revoke. Watchers fire per Db.delete: the grant watcher removes grantee-side cards for
    // my content AND my cards for others' content — the synchronous "gone right away" contract.
    // Already-deleted ids no-op (resume-safe).
    await this.deleteGrantsById(
      db,
      deletion.manifestGrants.map((grant) => grant.id)
    );

    // 5. Flip the user row through the ONE standing write path (audited), then stamp the
    // deletion columns. deleteRequestedAt = the manifest row's own creation time, so a resumed
    // call re-writes identical values.
    await new SetUserStatus().setUserStatus(user.id, 'deactivated');
    await db.update(tables.User, {
      id: user.id,
      deleteRequestedAt: deletion.created,
      purgeAfter: deletion.purgeAfter,
    });

    // Deletion-requested email (§9.4-1) — the only cancel channel an account-takeover victim
    // has. The deletion state is already durable, so a mail-transport failure logs loudly
    // instead of misreporting the committed deactivation as failed.
    try {
      await new AccountDeletionEmails().sendDeletionRequested(user.email, deletion.purgeAfter);
    } catch (error: any) {
      this.logger.error({
        message: 'Failed to send the deletion-requested email',
        obj: { userId: user.id },
        error,
      });
    }

    // 6. Kill sessions last — SocketIOSessionWatcher disconnects every live socket, including
    // the caller's own.
    await db.delete(tables.Session, { userEmail: user.email });

    // 7. The UI's confirmation copy renders from this.
    return { purgeAfter: deletion.purgeAfter };
  }

  /**
   * §3.4 — logging back in IS the cancel (called by the login route after `authenticate`
   * passes, BEFORE `request.login`). Not RPC-reachable: it is deliberately absent from the
   * AccountDeletionService interface, so the service router never exposes it.
   */
  async cancelPendingDeletion(email: string): Promise<'not-pending' | 'restored' | 'purging'> {
    const db = getDbAsSystem();
    const deletion = await db.get(tables.AccountDeletion, { userEmail: email.toLowerCase() });
    if (!deletion) {
      return 'not-pending';
    }

    // CAS claim (RoutineTicker shape): one winner across this login, concurrent logins, and the
    // purge walker. 'restoring' re-entry covers a crashed prior cancel. No purgeAfter check —
    // this CAS is the arbiter, so a user beating the walker to a just-expired window wins
    // honestly.
    const claimSeq = (deletion.leaseSeq ?? 0) + 1;
    const claimQb = new QueryBuilderFactory()
      .createQueryBuilder(tables.AccountDeletion)
      .condition({ field: 'userId', operator: '=', value: deletion.userId })
      .condition({ field: 'phase', operator: 'IN', value: ['grace', 'restoring'] })
      .condition({ field: 'leaseSeq', operator: '=', value: deletion.leaseSeq ?? 0 });
    const claimed = await db.update(tables.AccountDeletion, { phase: 'restoring', leaseSeq: claimSeq }, claimQb);
    if (claimed !== 1) {
      const current = await db.get(tables.AccountDeletion, { userId: deletion.userId });
      if (!current) {
        return 'not-pending'; // a concurrent cancel finished the restore — normal login proceeds
      }
      if (current.phase === 'purging' || current.phase === 'purged') {
        return 'purging'; // the walker won — no longer restorable
      }
      throw new Error(`A concurrent restore is in flight for account ${deletion.userId} — retry login.`);
    }

    // Re-insert manifest grants idempotently (fresh ids). The grant watcher's afterInsert
    // rebuilds content_reference cards through the normal path — grantees' cards for my content
    // AND my cards for inbound shares — synchronously, before the login response.
    await this.restoreManifestGrants(db, deletion.manifestGrants);

    // User row back to standing through the audited path; deletion stamps nulled.
    await new SetUserStatus().setUserStatus(deletion.userId, 'active');
    await db.update(tables.User, { id: deletion.userId, deleteRequestedAt: null, purgeAfter: null });

    await db.delete(tables.AccountDeletion, { id: deletion.id });
    return 'restored';
  }

  /** Verify the caller's password against their own account row; throws with nothing written. */
  private async reauthenticateSessionUser(password: string): Promise<User> {
    const sessionUser = new UserRepo().getUser();
    const adminCredentials = DefaultAdminCredentials.getCredentials();
    if (adminCredentials && sessionUser.email === adminCredentials.username) {
      throw new Error('The default admin session has no account row to delete.');
    }
    if (!sessionUser.id || !sessionUser.email) {
      throw new Error('Account deletion requires a signed-in account.');
    }

    // Fetch by email only and verify in code (both stored formats). No rehash here — this
    // method's contract is "throws with nothing written"; legacy rows migrate at login.
    const user = await getDbAsSystem().get(tables.User, { email: sessionUser.email.toLowerCase() });
    if (!user || !(await new PasswordHasher().verify(user.password, password))) {
      throw new Error('Password incorrect');
    }

    return user;
  }

  /**
   * §3.3 step 3: enumerate grants in both directions and persist the manifest row — phase
   * 'grace', full grant set, owned-resource snapshot — before any mutation.
   */
  private async createDeletionManifest(db: Db, user: User): Promise<AccountDeletionRecord> {
    const qbf = new QueryBuilderFactory();

    // Owner grants are the authoritative ownership signal (backed by
    // idx_ag_principal_table_level_resource). They are NOT revoked at deactivation — the purge
    // walker deletes them terminally after the walk that enumerates from this snapshot.
    const ownerQb = qbf
      .createQueryBuilder(tables.AccessGrant)
      .condition({ field: 'principal', operator: '=', value: user.id })
      .condition({ field: 'accessLevel', operator: '=', value: 'owner' });
    const ownerGrants = await db.query(tables.AccessGrant, ownerQb);
    const ownedResourceIds = Array.from(
      new Set(ownerGrants.map((grant) => this.referenceId(grant.resource, grant.id)))
    );

    // Inbound: my non-owner grants on other people's content.
    const inboundQb = qbf
      .createQueryBuilder(tables.AccessGrant)
      .condition({ field: 'principal', operator: '=', value: user.id })
      .condition({ field: 'accessLevel', operator: 'IN', value: ['read', 'write', 'admin'] });
    const inbound = await db.query(tables.AccessGrant, inboundQb);

    // Outbound: grants on my content held by anyone else (no resource-side index — chunked
    // IN-list enumeration, acceptable at MVP scale).
    const outbound: AccessGrant[] = [];
    for (const idsChunk of this.chunk(ownedResourceIds, GRANT_CHUNK_SIZE)) {
      const outboundQb = qbf
        .createQueryBuilder(tables.AccessGrant)
        .condition({ field: 'resource', operator: 'IN', value: idsChunk });
      const grants = await db.query(tables.AccessGrant, outboundQb);
      outbound.push(...grants.filter((grant) => this.referenceId(grant.principal, grant.id) !== user.id));
    }

    const graceDays = this.gracePeriodDays();
    return await db.insert(tables.AccountDeletion, {
      userId: user.id,
      userEmail: user.email,
      phase: 'grace',
      purgeAfter: moment().add(Math.round(graceDays * 24 * 60 * 60 * 1000), 'milliseconds'),
      manifestGrants: [...inbound, ...outbound].map((grant) => this.toManifestGrant(grant)),
      ownedResourceIds,
      leaseSeq: 0,
    });
  }

  /** Revoke grants by manifest id, in chunks of 100. Already-deleted ids no-op. */
  private async deleteGrantsById(db: Db, grantIds: string[]): Promise<void> {
    for (const idsChunk of this.chunk(grantIds, GRANT_CHUNK_SIZE)) {
      const qb = new QueryBuilderFactory()
        .createQueryBuilder(tables.AccessGrant)
        .condition({ field: 'id', operator: 'IN', value: idsChunk });
      await db.delete(tables.AccessGrant, qb);
    }
  }

  /** §3.4 step 3: per entry, get by (principal, resource, accessLevel) → insert if missing. */
  private async restoreManifestGrants(db: Db, manifestGrants: ManifestGrant[]): Promise<void> {
    for (const grant of manifestGrants) {
      const existingQb = new QueryBuilderFactory()
        .createQueryBuilder(tables.AccessGrant)
        .condition({ field: 'principal', operator: '=', value: grant.principal })
        .condition({ field: 'resource', operator: '=', value: grant.resource })
        .condition({ field: 'accessLevel', operator: '=', value: grant.accessLevel });
      const existing = await db.query(tables.AccessGrant, existingQb);
      if (existing.length > 0) {
        continue;
      }

      await db.insert(tables.AccessGrant, {
        principal: new Reference(tables.User.name, grant.principal),
        // Serialization fails loudly on a missing table name — a table-less grant is corrupt.
        resource: new Reference(grant.resourceTable ?? '', grant.resource),
        resourceTable: grant.resourceTable,
        accessLevel: grant.accessLevel,
      });
    }
  }

  private toManifestGrant(grant: AccessGrant): ManifestGrant {
    return {
      id: grant.id,
      principal: this.referenceId(grant.principal, grant.id),
      resource: this.referenceId(grant.resource, grant.id),
      resourceTable: grant.resourceTable,
      accessLevel: grant.accessLevel,
    };
  }

  /** A grant reference's id, loudly — the manifest must never be built from corrupt grants. */
  private referenceId(reference: Reference<any>, grantId: string): string {
    if (!reference?._id) {
      throw new Error(`access_grant ${grantId} has a reference with no id — refusing to build a deletion manifest.`);
    }
    return reference._id;
  }

  /**
   * Grace window in days (ACCOUNT_DELETION_GRACE_DAYS, default 30). Fractional values are
   * honored so dev verification can shorten the window to minutes.
   */
  private gracePeriodDays(): number {
    const raw = process.env.ACCOUNT_DELETION_GRACE_DAYS;
    if (raw === undefined || raw === '') {
      return 30;
    }

    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`ACCOUNT_DELETION_GRACE_DAYS must be a non-negative number of days, got '${raw}'`);
    }
    return days;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }
}
