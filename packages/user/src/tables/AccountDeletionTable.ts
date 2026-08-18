import {
  DateTimeColumn,
  IntegerColumn,
  ObjectColumn,
  StringColumn,
  Table,
  Record,
  withRecordColumns,
} from '@proteinjs/db';
import { Moment } from 'moment';
import { USER_PERMISSIONS } from '../permissions';
import { AccessGrant } from './AccessGrantTable';

/** Purge-machine phases. `grace` = cancelable window; `restoring` = a cancel-by-login claimed the
 *  row; `purging` = the walker claimed it; `purged` = rows erased, completion email pending. */
export const ACCOUNT_DELETION_PHASES = ['grace', 'restoring', 'purging', 'purged'] as const;
export type AccountDeletionPhase = (typeof ACCOUNT_DELETION_PHASES)[number];

/**
 * A revoked `access_grant` row serialized verbatim into the deletion manifest. The stored `id`
 * lets revocation delete precisely and resume idempotently; cancel re-inserts WITHOUT ids
 * (fresh rows), matched by `(principal, resource, accessLevel)`.
 */
export type ManifestGrant = {
  /** id of the revoked access_grant row */
  id: string;
  /** user id (the grant's principal) */
  principal: string;
  /** resource id (the grant's resource) */
  resource: string;
  resourceTable?: string;
  accessLevel: AccessGrant['accessLevel'];
};

/**
 * One row per in-flight account deletion: the deletion manifest plus the purge machine's own
 * state. Deliberately a plain `Record`, NOT scoped — it must survive the purge walker's scope
 * sweep and outlive the `user` row (the completion email sends after the user is gone).
 */
export interface AccountDeletion extends Record {
  /** unique — one in-flight deletion per account */
  userId: string;
  /** Completion-email addressee after the user row is gone; login-cancel lookup key. */
  userEmail: string;
  phase: AccountDeletionPhase;
  /** Write-once copy of `user.purgeAfter` (same logical step; this row is the machine's own stamp). */
  purgeAfter: Moment;
  /**
   * Revoked grants, BOTH directions (inbound: my non-owner grants on others' content; outbound:
   * others' grants on my content), verbatim. Persisted BEFORE any mutation — after a partial
   * revocation the live grants under-count, so resume must never re-enumerate.
   */
  manifestGrants: ManifestGrant[];
  /**
   * Owner-grant resource ids snapshotted at deactivation — the purge walker's thought-domain id
   * source. LOAD-BEARING: ThoughtAccessGrantCleanupTableWatcher deletes a thought's grants the
   * moment its row dies, so live re-enumeration after a mid-tree crash would strand orphan
   * children forever.
   */
  ownedResourceIds: string[];
  /** CAS token (RoutineTicker.tickSeq pattern), bumped on every claim. */
  leaseSeq: number;
  ownerNodeId?: string | null;
  /** JS-compared (Spanner timestamp-condition house rule). */
  heartbeatAt?: Moment | null;
}

/**
 * Locked like `SessionTable`: readable behind the 'users' permission, and NO write doors — rows
 * are system-written only (the deletion service and the purge walker ride system paths, which
 * bypass TableAuth). The manifest holds cross-user grant data, so even break-glass admin gets
 * no generic write surface.
 */
export class AccountDeletionTable extends Table<AccountDeletion> {
  name = 'account_deletion';
  auth: Table<AccountDeletion>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
    },
  };
  indexes = [
    { name: 'idx_account_deletion_user_id_unique', columns: ['userId'] as (keyof AccountDeletion)[], unique: true },
  ];
  columns = withRecordColumns<AccountDeletion>({
    userId: new StringColumn('user_id', {}, 36),
    userEmail: new StringColumn('user_email', {}, 250),
    phase: new StringColumn<AccountDeletionPhase>('phase', {}, 16),
    purgeAfter: new DateTimeColumn('purge_after'),
    manifestGrants: new ObjectColumn<ManifestGrant[]>('manifest_grants'),
    ownedResourceIds: new ObjectColumn<string[]>('owned_resource_ids'),
    leaseSeq: new IntegerColumn('lease_seq'),
    ownerNodeId: new StringColumn('owner_node_id'),
    heartbeatAt: new DateTimeColumn('heartbeat_at'),
  });
}
