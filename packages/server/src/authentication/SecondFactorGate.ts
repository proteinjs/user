import { getDbAsSystem } from '@proteinjs/db';
import { RolesCatalog, User, tables } from '@proteinjs/user';
import { devLoopDoorsOpen } from '../routes/devLoopDoorsOpen';
import { getPasskeyRelyingParty } from './passkeys/PasskeyRelyingParty';

/**
 * A session's record of the second factor it was opened with — kept in the session's stored data,
 * written by the session's one opener (`establishSession`) in the same save that binds the
 * account, and read on every request (`userCache`):
 * - `passkey` — the sign-in's passkey step passed; `passkeyId` names the passkey row that opened it;
 * - `dev` — the development sign-in door opened it, with no credential at all.
 */
export type SecondFactorRecord = { method: 'passkey' | 'dev'; passkeyId?: string; at: string };

/**
 * The ONE owner of "must this account use a second factor, and has this session met it".
 *
 * WHO MUST. An account must use a passkey when all three hold:
 * 1. the deployment declares a relying party (`PasskeyRelyingParty`) — a consumer that declares
 *    none has no second factor, and nothing here refuses anything;
 * 2. the account is not a declared machine account: `isLoadedFromSource` is not true. That flag
 *    is the boot sync's alone — no client writes it, and a role grant to such a row is refused —
 *    so an exempt account holds exactly the roles its declaration names, and no person signs it
 *    in. The `machine` column is NOT read here: a row marked machine by hand is a person's
 *    account for this rule;
 * 3. it holds at least one administrative role (`RolesCatalog.isAdministrative`: break-glass,
 *    admin-grant-only, or marked administrative). A role the catalog does not know is not one.
 * The built-in default admin (`createAuthentication`'s credentials — an identity with no account
 * row) holds `admin` and can hold no passkey: where a relying party is declared its sessions do
 * not resolve.
 *
 * WHEN MET. A session has met it when its stored data carries a record whose method is `passkey`,
 * or `dev` while this process's development switches are set (`devLoopDoorsOpen` — the development
 * door's own gate): a session the development door opened is worth nothing on a deployment that
 * sets neither switch.
 */
export class SecondFactorGate {
  /** The key the record sits under in a session's stored data. */
  static readonly SESSION_KEY = 'secondFactor';

  /** Whether the account must use a second factor to hold a session. */
  mustUse(user: Pick<User, 'roles' | 'isLoadedFromSource'>): boolean {
    return (
      user.isLoadedFromSource !== true &&
      (user.roles ?? []).some((role) => RolesCatalog.isAdministrative(role)) &&
      getPasskeyRelyingParty() !== undefined
    );
  }

  /** Whether the session's stored data carries a record that meets the factor on this process. */
  async sessionMet(sessionId: string): Promise<boolean> {
    if (!sessionId) {
      return false;
    }

    const row = await getDbAsSystem().get(tables.Session, { sessionId });
    const method = this.recordIn(row?.session)?.method;
    return method === 'passkey' || (method === 'dev' && devLoopDoorsOpen(process.env));
  }

  /** The record a session's stored data carries, or undefined when it carries none or cannot be read. */
  private recordIn(stored: string | undefined): Partial<SecondFactorRecord> | undefined {
    if (!stored) {
      return undefined;
    }

    try {
      const record = JSON.parse(stored)?.[SecondFactorGate.SESSION_KEY];
      return record && typeof record === 'object' ? record : undefined;
    } catch (error) {
      return undefined;
    }
  }
}
