import { DataEncryptionKeyTable, QueryBuilder, Reference, Table, getDbAsSystem } from '@proteinjs/db';
import type { DataEncryptionKey, DbEncryptionConfig } from '@proteinjs/db';

import { AccessGrant } from './tables/AccessGrantTable';
import { isSharedTable, skipAccessGrantsEnabled } from './SharedRecord';
import { UserRepo } from './UserRepo';
import { tables } from './tables/tables';

/** One resolved scope-root owner, cached briefly (see `SharedScopeKeyOwners`). */
interface OwnerCacheEntry {
  cachedAt: number;
  owner: string;
}

/**
 * The sharing-aware half of the column-encryption key model (TRUST_AND_COMPLIANCE §4/§4.4;
 * SHARING_EXPANSION §3): rows in a shared permission scope are keyed by the SCOPE-ROOT
 * OWNER's data key, and a reader's encrypted-search fingerprints fan out over the owners
 * sharing content into their view. Compose an instance into the app's `DbEncryptionConfig`:
 *
 * ```ts
 * const keyOwners = new SharedScopeKeyOwners();
 * const config: DbEncryptionConfig = {
 *   masterKeyProvider,
 *   resolveKeyOwner: (args) => keyOwners.resolveKeyOwner(args),
 *   getAccessibleKeyOwners: (args) => keyOwners.getAccessibleKeyOwners(args),
 * };
 * ```
 *
 * Design facts this class is the single owner of:
 *
 * - **Owner-keyed shared scopes.** A `SharedRecord` row's key owner is the principal of the
 *   EARLIEST `owner` grant on its permission source (creation order; the creator). A
 *   contributor's write into someone else's document is keyed by the DOCUMENT owner, never
 *   the writer — so crypto-shred agrees exactly with the account-deletion purge walker,
 *   which drains shared trees grant-derived (by owned permission sources, never by the
 *   writer's scope): the rows a deletion removes and the rows a shred unreads are the same
 *   set. Keys are NOT access control — whether a reader may see a row is the permission
 *   layer's decision; revoking a share revokes access without re-encrypting anything.
 * - **Root birth.** A scope root's owner grant is minted only after its insert lands
 *   (`SharedRecord.onAfterInsert`), so a root insert that touches encrypted columns resolves
 *   the creator (the session user) directly — the same identity the grant is about to name.
 * - **Accessible owners = self + every OTHER owner-grant principal on resources the caller
 *   holds any grant on.** Resource-agnostic (thought, chat, space — whatever rides
 *   AccessGrant) and bounded by how much is shared with the caller. This includes conferred
 *   co-owners in both directions. Computed fresh per query — a revoked share drops out of
 *   the fan-out immediately (the permission layer already refused the rows themselves).
 * - **System queries** (`runAsSystem`) search under EVERY key owner (the
 *   `data_encryption_key` owner set): an unscoped query silently missing rows of
 *   inaccessible owners would be a wrong answer, not a degraded one. Rare by design;
 *   cost scales with the owner count, correctness does not.
 * - **Non-shared tables fall through** (`resolveKeyOwner` returns undefined): the framework
 *   default — the row's `scope` column — already IS the scope owner for ScopedRecord tables.
 *
 * Named limitation (owner transfer): after a full ownership transfer (a conferred owner
 * grant plus deletion of the original owner's), NEW writes key under the new owner while
 * historical rows keep their old envelopes. Readers whose grant set no longer reaches the
 * old owner can still read those rows (envelopes are self-describing) but search fan-out no
 * longer covers them; a lifecycle re-encrypt walk over the tree converges the envelopes to
 * the current owner.
 */
export class SharedScopeKeyOwners {
  /** Scope-root owner cache TTL — bounds cross-process staleness after an ownership transfer. */
  private static readonly OWNER_TTL_MS = 60 * 1000;
  private static readonly OWNER_CACHE_MAX_ENTRIES = 10_000;
  private static readonly OWNER_CACHE_GLOBAL_KEY = '__proteinjs_user_sharedScopeOwnerCache';

  /**
   * The data-key owner for a `SharedRecord` row being written: the earliest `owner`-grant
   * principal on the row's permission source, or the session user for a scope-root birth
   * (whose grant is minted post-DML). Returns undefined for non-shared tables and for rows
   * whose owner cannot be resolved — the framework then falls through to the row's `scope`
   * value or refuses the write loudly (`EncryptionRecordHooks.resolveKeyOwnerForWrite`).
   */
  async resolveKeyOwner(args: { table: Table<any>; record: any }): Promise<string | undefined> {
    const { table, record } = args;
    if (!isSharedTable(table)) {
      return undefined;
    }

    const sourceId = this.referenceId(record?.permissionSource);
    const sourceTable: string = record?.permissionSourceTable ?? table.name;
    if (!sourceId) {
      return undefined;
    }

    if (skipAccessGrantsEnabled()) {
      // Grant machinery is off (test environments): the only resolvable owner is the caller.
      return new UserRepo().getUser().id || undefined;
    }

    const cacheKey = `${sourceTable}:${sourceId}`;
    const cached = this.ownerCache().get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < SharedScopeKeyOwners.OWNER_TTL_MS) {
      return cached.owner;
    }

    const owner = await this.scopeRootOwner(sourceId, sourceTable);
    if (owner) {
      this.cacheOwner(cacheKey, owner);
      return owner;
    }

    // Scope-root birth: the row IS its own permission source and its owner grant does not
    // exist yet — the creator (session user) is the owner that grant is about to name. Not
    // cached: the authoritative grant lands post-DML.
    if (sourceId === record?.id && sourceTable === table.name) {
      return new UserRepo().getUser().id || undefined;
    }

    return undefined;
  }

  /**
   * The key owners whose rows the current caller's encrypted searches must cover (see the
   * class doc for the definition). Loud refusal when no caller identity exists on a
   * non-system query: returning an empty set would make the search silently match nothing.
   */
  async getAccessibleKeyOwners(args: { runAsSystem: boolean }): Promise<string[]> {
    if (args.runAsSystem) {
      return await this.allKeyOwners();
    }

    const callerId = new UserRepo().getUser().id;
    if (!callerId) {
      throw new Error(
        `Cannot search encrypted columns without a caller identity: no session user is present. ` +
          `System-context searches cover all key owners; caller-context searches require a signed-in user.`
      );
    }

    if (skipAccessGrantsEnabled()) {
      return [callerId];
    }
    // Every OTHER owner-grant principal on resources the caller holds any grant on — the
    // same subquery shape SharedRecord's access filter uses, inverted onto the owner side.
    const callerResources = new QueryBuilder(tables.AccessGrant.name);
    callerResources.select({ fields: ['resource'] });
    callerResources.condition({ field: 'principal', operator: '=', value: callerId });

    const qb = new QueryBuilder(tables.AccessGrant.name);
    qb.condition({ field: 'accessLevel', operator: '=', value: 'owner' });
    qb.condition({ field: 'principal', operator: '!=', value: callerId });
    qb.condition({ field: 'resource', operator: 'IN', value: callerResources });
    const otherOwnerGrants = await getDbAsSystem<AccessGrant>().query(tables.AccessGrant, qb);

    const owners = new Set<string>([callerId]);
    for (const grant of otherOwnerGrants) {
      const principalId = this.referenceId(grant.principal);
      if (principalId) {
        owners.add(principalId);
      }
    }

    return Array.from(owners);
  }

  /**
   * The earliest `owner`-grant principal on a permission source — the scope-root owner.
   * Earliest by creation (id tiebreak) so a document with conferred co-owners still keys
   * deterministically by its original owner.
   */
  private async scopeRootOwner(sourceId: string, sourceTable: string): Promise<string | undefined> {
    const qb = new QueryBuilder(tables.AccessGrant.name);
    qb.condition({ field: 'resource', operator: '=', value: sourceId });
    qb.condition({ field: 'resourceTable', operator: '=', value: sourceTable });
    qb.condition({ field: 'accessLevel', operator: '=', value: 'owner' });
    const grants = await getDbAsSystem<AccessGrant>().query(tables.AccessGrant, qb);
    if (grants.length === 0) {
      return undefined;
    }

    const earliest = grants.reduce((best, candidate) => {
      const bestCreated = best.created?.valueOf() ?? 0;
      const candidateCreated = candidate.created?.valueOf() ?? 0;
      if (candidateCreated !== bestCreated) {
        return candidateCreated < bestCreated ? candidate : best;
      }
      return candidate.id < best.id ? candidate : best;
    });
    return this.referenceId(earliest.principal);
  }

  /** Every key owner that exists — the distinct `data_encryption_key` owner set. */
  private async allKeyOwners(): Promise<string[]> {
    const keyTable = new DataEncryptionKeyTable() as Table<DataEncryptionKey>;
    const rows = await getDbAsSystem<DataEncryptionKey>().query(keyTable, {} as Partial<DataEncryptionKey>);
    return Array.from(new Set(rows.map((row) => row.owner)));
  }

  /** The id inside a `Reference`-or-string field, or undefined. */
  private referenceId(value: Reference<any> | string | undefined | null): string | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    return value._id || undefined;
  }

  /**
   * Cache on the global object (the duplicate-module pattern — see `setSkipAccessGrants`):
   * per-package installs put multiple live copies of this class in one process, and the
   * scope-root owner must be one answer across all of them.
   */
  private ownerCache(): Map<string, OwnerCacheEntry> {
    const globalObject = globalThis as any;
    if (!globalObject[SharedScopeKeyOwners.OWNER_CACHE_GLOBAL_KEY]) {
      globalObject[SharedScopeKeyOwners.OWNER_CACHE_GLOBAL_KEY] = new Map<string, OwnerCacheEntry>();
    }
    return globalObject[SharedScopeKeyOwners.OWNER_CACHE_GLOBAL_KEY];
  }

  private cacheOwner(cacheKey: string, owner: string) {
    const cache = this.ownerCache();
    if (cache.size >= SharedScopeKeyOwners.OWNER_CACHE_MAX_ENTRIES) {
      cache.clear();
    }
    cache.set(cacheKey, { cachedAt: Date.now(), owner });
  }
}

/**
 * Type-level check that the two methods satisfy the framework seams they compose into —
 * a drifted signature fails compilation here, not at an app's config site.
 */
type _ResolveKeyOwnerSeam = NonNullable<DbEncryptionConfig['resolveKeyOwner']>;
type _GetAccessibleKeyOwnersSeam = NonNullable<DbEncryptionConfig['getAccessibleKeyOwners']>;
const _seamCheck: {
  resolveKeyOwner: _ResolveKeyOwnerSeam;
  getAccessibleKeyOwners: _GetAccessibleKeyOwnersSeam;
} = {
  resolveKeyOwner: (args) => new SharedScopeKeyOwners().resolveKeyOwner(args),
  getAccessibleKeyOwners: (args) => new SharedScopeKeyOwners().getAccessibleKeyOwners(args),
};
void _seamCheck;
