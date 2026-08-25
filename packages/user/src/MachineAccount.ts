import { SourceRecordLoader, Table, getSourceRecordLoaders } from '@proteinjs/db';
import { RolesCatalog } from './RolesCatalog';
import { tables } from './tables/tables';
import { User } from './tables/UserTable';

/**
 * Every machine account declared into the user table. Duck-typed rather than `instanceof`
 * (declarations may load from a different package copy in mixed-resolution environments):
 * a user-table source-record declaration carrying a `secretName` is a machine account.
 */
export const getMachineAccounts = (): MachineAccount[] =>
  getSourceRecordLoaders<User>()
    // db ≥1.34.4 pairs each loader with its owning source package (the shared-db ownership
    // grain); the machine-account read wants the loaders themselves.
    .map(({ loader }) => loader)
    .filter(
      (loader): loader is MachineAccount =>
        loader.table.name === tables.User.name && typeof (loader as MachineAccount).secretName === 'string'
    );

/**
 * A code-declared machine account: identity in source, credentials at runtime.
 *
 * Extend this (server-side — declarations name real operational emails and grants) to declare a
 * machine account into the `user` table. The boot sync inserts it on first boot of a fresh env,
 * ADOPTS an existing row by email in deployed envs (id kept — rows the account filed reference
 * it; password kept — the credential is runtime-owned), reverts the declared fields on every
 * boot (a runtime grant/revoke on a machine account is drift), and deactivates the account —
 * sessions killed, never deleted — when the declaration is removed. Git history of the
 * declaration is the machine-grant audit trail; the Roles service refuses machine targets.
 *
 * A `password` is deliberately NOT declarable: a fresh machine row has a NULL password, which
 * `authenticate`'s verify treats as matching no password at all, so "account exists" can never
 * reach "account can log in" without the explicit credential mint (`MachineCredentialsService`).
 */
export abstract class MachineAccount implements SourceRecordLoader<User> {
  /** Stable id, used ONLY when inserting into a fresh env — existing rows adopt by email. */
  abstract id: string;
  /** The account's email (lowercase — validated at boot). The natural key adoption matches on. */
  abstract email: string;
  /** Display name shown wherever the account's actions surface. */
  abstract accountName: string;
  /**
   * The account's role grants, declared — reverted to exactly this set on every boot. Each must
   * be a catalog-known role; break-glass roles are refused (a machine account holding 'admin' is
   * unrepresentable).
   */
  abstract roles: string[];
  /**
   * Name of the Secret Manager secret the account's minted credential is pasted into — operator
   * metadata surfaced by the credential mint, not a database column.
   */
  abstract secretName: string;

  get table(): Table<User> {
    return tables.User;
  }

  get record(): SourceRecordLoader<User>['record'] {
    this.validate();
    return {
      id: this.id,
      email: this.email,
      name: this.accountName,
      roles: [...this.roles],
      // No mailbox ceremony for machines; forced so runtime flips get reverted.
      emailVerified: true,
      // Source-owned on purpose: re-declaring a removed (auto-deactivated) account is what
      // reactivates it, via normal drift reversion.
      status: 'active',
      // The one contained cast (the codebase's sanctioned pattern for required-column typing):
      // `User.password` is a required column, but a machine declaration NEVER emits a password
      // key — the credential is runtime-owned, minted and stored as a hash by the credential
      // service. The loader only writes fields present on the record, so the column stays
      // untouched on adopted rows and NULL on fresh inserts (unloggable until minted).
    } as unknown as SourceRecordLoader<User>['record'];
  }

  /** Boot-time declaration validation — every violation fails the boot loudly by name. */
  private validate(): void {
    const describe = `MachineAccount declaration '${this.constructor.name}'`;
    if (!this.id || !this.email || !this.accountName || !this.secretName) {
      throw new Error(`${describe} must declare id, email, accountName, and secretName`);
    }

    if (this.email !== this.email.toLowerCase()) {
      throw new Error(
        `${describe} declares email '${this.email}' — machine account emails must be lowercase ` +
          `(authentication and the natural-key adoption both match on the lowercased email)`
      );
    }

    for (const role of this.roles) {
      const entry = RolesCatalog.getEntry(role);
      if (!entry) {
        throw new Error(`${describe} declares unknown role '${role}' — pick one from the roles catalog`);
      }

      if (entry.breakGlass) {
        throw new Error(
          `${describe} declares break-glass role '${role}' — machine accounts hold day-to-day ` +
            `permission-mapped roles only, never break-glass`
        );
      }
    }
  }
}
