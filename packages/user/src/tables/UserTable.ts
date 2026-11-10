import {
  ArrayColumn,
  BooleanColumn,
  StringColumn,
  PasswordColumn,
  Table,
  SourceRecord,
  withSourceRecordColumns,
  DateTimeColumn,
  Reference,
  ReferenceColumn,
} from '@proteinjs/db';
import { Moment } from 'moment';
import { USER_PERMISSIONS } from '../permissions';

/** Account standings. The vocabulary is owned here; every status write flows through the SetUserStatus service. */
export const USER_STATUSES = ['active', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * A mixed-ownership source-record table: rows with `isLoadedFromSource = true` are CODE-DECLARED
 * MACHINE ACCOUNTS (see `MachineAccount`) whose declared fields are brought to the declaration on
 * every boot while the row is as the sync left it (a declared column written at runtime makes the
 * row the product's — @proteinjs/db's authorship precedence); human rows (flag null/false) are
 * structurally untouchable by the boot sync. A machine
 * account removed from source is deactivated — never deleted — so rows it is referenced from
 * stay intact, and re-declaring it reactivates it. Whether a row IS a machine account is the
 * explicit `machine` column (founder ruling 2026-09-02) — `isLoadedFromSource` is the sync's
 * ownership flag and an input to the machine STAMP, never the question consumers ask.
 */
export type User = SourceRecord & {
  name: string;
  email: string;
  password: string;
  passwordResetToken?: string | null;
  passwordResetTokenExpiration?: Moment | null;
  emailVerified: boolean;
  /**
   * The email-verification token outstanding on an unverified account (its digest, never the
   * token — the same posture as the reset pair) and when it lapses. Minted at a no-invite sign-up
   * and by `SignupService.resendEmailVerification`; cleared by the verify-email route when the
   * link is tapped. An account created from an invite never carries one.
   */
  emailVerificationToken?: string | null;
  emailVerificationTokenExpiration?: Moment | null;
  /** Role names from the roles catalog (see `RolesCatalog`). Written ONLY by the Roles service. */
  roles: string[];
  /**
   * The user who invited this account (resolved from the invite at signup). Left DANGLING when
   * the inviter's account purges — that unresolvable id IS the pseudonymization the account
   * purge relies on; nothing rewrites it.
   */
  invitedBy?: Reference<User> | null;
  /**
   * Emoji avatar. At most one of `avatarEmoji`/`avatarFileId` is set — the avatar mutations in
   * UpdateUserInfo enforce it (every mutation assigns BOTH columns); nothing else writes these.
   */
  avatarEmoji?: string | null;
  /**
   * File id of the stored avatar photo (512x512 JPEG). A plain string, NOT a ReferenceColumn:
   * @proteinjs/db-file depends on @proteinjs/user, so a user→file reference would be circular.
   */
  avatarFileId?: string | null;
  /**
   * The EXPLICIT machine-account marker (founder ruling 2026-09-02): true = this row is a
   * MACHINE identity (CI signals, ops bridges — never a person); null/false = human, so
   * pre-existing human rows need no backfill (the `status`/opt-out null-default convention).
   * ONE owner for the question "is this a machine": every consumer (audience derivations,
   * people lists, purge walkers) reads THIS column — never `isLoadedFromSource`, which merely
   * says who SYNCS the row. Stamped true by the `MachineAccount` declaration (on insert and on
   * every boot after), by provisioning migrations for hand-made machine rows, and by
   * the source-loaded backfill (user-server BackfillMachineFlagForSourceLoadedAccounts). A
   * hand-made row marked machine is still never taken over by a declaration (the sync refuses a
   * row it does not own) — the marker only says what the row is.
   */
  machine?: boolean | null;
  /**
   * Account standing. Written ONLY by the SetUserStatus service (audited per change). New rows
   * default to 'active'; rows predating the column read null, which every gate treats as active —
   * only an explicit 'deactivated' is refused (authentication and session resolution both gate on
   * it in @proteinjs/user-server). The legacy null state is retired by the
   * BackfillUserStatusActive migration (@proteinjs/user-server), so deployed rows read a real
   * value; the gates' null-tolerant reading stays as the contract for any not-yet-migrated env.
   */
  status?: UserStatus | null;
  /** When the user asked for their account to be deleted. Written by the account-deletion flow only. */
  deleteRequestedAt?: Moment | null;
  /** When the grace window ends and the purge walker may erase the account. Written by the account-deletion flow only. */
  purgeAfter?: Moment | null;
};

export class UserTable extends Table<User> {
  name = 'user';
  /**
   * The 'users' permission READS user records. The table has NO generic write door on either
   * api: a declared block's undeclared operations stay closed to everyone (`TableAuth`), so every
   * `DbService` insert, update and delete on this table is refused whoever asks — admins
   * included. Every write from a client is a named, audited service: a person's own name,
   * password and avatar through UpdateUserInfo; another account's name, email and email-verified
   * flag through UserAccountAdmin (permission 'users', a `user_account_event` row per change);
   * roles through Roles ('roles', a `role_grant_event` row); standing through SetUserStatus
   * (admin, a `user_status_event` row). The service-only shape is what keeps a 'users' holder from
   * writing another account's password cell raw through the generic RPC — a hash-shaped value
   * written there verified as a legacy credential.
   *
   * The db api has no write door either — the session and audit tables' shape: server code
   * writes this table through the system path (which bypasses TableAuth), never as the calling
   * user, so a db-api write door would be a standing grant with nothing behind it and no belt
   * (`serviceProtectedColumns` is enforced at the RPC gate alone). Closed on both apis, the
   * doors cannot be reached by any caller, through any door, admin included.
   */
  auth: Table<User>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
    },
    /**
     * The belt under the closed doors: were a write door ever declared again, these cells would
     * still refuse the generic RPC. `roles` is written only by the Roles service; `status` only by
     * the SetUserStatus service (both audited per change — a generic RPC write would let the stored
     * state diverge from its audit trail). `deleteRequestedAt`/`purgeAfter` drive the account
     * purge machinery and are written only by the server-side deletion flow. `isLoadedFromSource`
     * is machine-account ownership — written only by the boot sync; an RPC write could hand a
     * human row to source ownership (or unhook a machine row from it). The credential cells —
     * `password` (PasswordHasher is its one writer), the reset and verification token pairs
     * (MailedToken's) — and `email` (the session's key and the sign-in identity; changed only
     * through UserAccountAdmin, which un-verifies it) are auth material no RPC may set.
     */
    serviceProtectedColumns: [
      'roles',
      'status',
      'deleteRequestedAt',
      'purgeAfter',
      'isLoadedFromSource',
      'password',
      'passwordResetToken',
      'passwordResetTokenExpiration',
      'emailVerificationToken',
      'emailVerificationTokenExpiration',
      'email',
    ],
  };
  /**
   * Machine accounts sync by EMAIL, not id: accounts adopted from hand-made rows before
   * declarations existed keep their env-random ids, which other rows reference (declared fields
   * brought to the declaration while the row is as the sync left it, runtime fields like
   * `password` untouched). A row the sync does not own under a
   * declared email — a person's signup, a hand-made row — is never taken over: the natural key
   * refuses the declaration (@proteinjs/db). Removal from source deactivates (the same status the
   * staff toggle and account deletion write — the UserStatusTableWatcher kills sessions on every
   * deactivation write); re-declaring reactivates via normal drift reversion.
   */
  sourceRecordOptions: Table<User>['sourceRecordOptions'] = {
    naturalKey: 'email',
    onSourceRemoved: { update: { status: 'deactivated' } },
  };
  columns = withSourceRecordColumns<User>({
    name: new StringColumn('name'),
    /**
     * Unique — codifying the invariant authenticate/Signup always assumed (lowercased +
     * existence-checked). Also the machine-account natural key: adoption requires unambiguous
     * matching. The schema sync's duplicate preflight names offending values if a deployed env
     * somehow holds dupes when the index first lands.
     */
    email: new StringColumn('email', { unique: { unique: true, indexName: 'user_email_unique' } }, 250),
    password: new PasswordColumn('password'),
    // Auth-internal reset-token state: server write paths only — no admin surface (table or
    // form) has business rendering it, so it hides from the generic record UI like `password`.
    passwordResetToken: new StringColumn('password_reset_token', { ui: { hidden: true } }),
    passwordResetTokenExpiration: new DateTimeColumn('password_reset_token_expiration', { ui: { hidden: true } }),
    emailVerified: new BooleanColumn('email_verified'),
    // The verification pair hides like the reset pair: auth-internal, server write paths only.
    emailVerificationToken: new StringColumn('email_verification_token', { ui: { hidden: true } }),
    emailVerificationTokenExpiration: new DateTimeColumn('email_verification_token_expiration', {
      ui: { hidden: true },
    }),
    /**
     * Typed array in the `role_list` column. The legacy comma-string `roles` column (STRING(255))
     * is still physically present on databases that predate the cutover — Spanner cannot retype
     * in place, so the cutover was new column + backfill (`@proteinjs/user-server`
     * BackfillUserRolesArray) + this code cutover. Its cells are NOT invisible to the ORM: a
     * row carries them under the stored key `roles`, which is also this property's name, and the
     * row reader seats a cell by its declared column name alone (@proteinjs/db ≥ 1.55.0) — so
     * the legacy cell is omitted and the array survives beside it, whatever it holds and
     * whichever physical position it has (the stored-value contract suite in @proteinjs/db; the
     * backfill suite in @proteinjs/user-server reads this very shape). The cells are retired by
     * RetireLegacyUserRolesColumn once `role_list` carries the roles.
     */
    roles: new ArrayColumn<string>('role_list'),
    /**
     * A reference at the column's ORIGINAL string width: `invited_by` predates the reference
     * type as a STRING(255) uuid column, and a reference stores the same id bytes — adopting
     * the existing width (`maxLength`) makes the retype invisible to the schema sync (zero DDL;
     * Spanner could not narrow to the 36 default in place anyway).
     */
    invitedBy: new ReferenceColumn<User>('invited_by', 'user', false, { maxLength: 255 }),
    avatarEmoji: new StringColumn('avatar_emoji'),
    avatarFileId: new StringColumn('avatar_file_id'),
    machine: new BooleanColumn('machine'),
    status: new StringColumn<UserStatus>('status', { defaultValue: async () => 'active' }, 16),
    deleteRequestedAt: new DateTimeColumn('delete_requested_at'),
    purgeAfter: new DateTimeColumn('purge_after'),
  });
}
