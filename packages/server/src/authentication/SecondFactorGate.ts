import { RolesCatalog, User } from '@proteinjs/user';
import { devLoopDoorsOpen } from '../routes/devLoopDoorsOpen';
import { DbSessionStore } from './DbSessionStore';
import { RelyingParty, getPasskeyRelyingParty } from './passkeys/PasskeyRelyingParty';

/**
 * A session's record of the second factor it was opened with — kept in the session's stored data,
 * written by the session's one opener (`establishSession`) in the same save that binds the
 * account, and read on every request (`userCache`):
 * - `passkey` — the sign-in's passkey step passed; `passkeyId` names the passkey row that opened it;
 * - `dev` — the development sign-in door opened it, with no credential at all.
 */
export type SecondFactorRecord = { method: 'passkey' | 'dev'; passkeyId?: string; at: string };

/**
 * The ONE owner of "must this account use a second factor, and has this session met it". Both
 * questions are answered here and nowhere else, and the deployment's relying-party declaration is
 * read here and nowhere else: the sign-in door and the per-request check ask `mustUse`, the
 * passkey services hand its answer to a page (`required`: a person's own, `PasskeysService.list`;
 * another person's, `PasskeyAdminService.count`) so no page keeps a copy of the rule, and the
 * passkey step takes the values its ceremonies run against from `relyingParty`.
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
 * The built-in default admin (`DefaultAdminCredentials` — an identity with no account row) holds
 * `admin` and can hold no passkey: where a relying party is declared it must use one and never
 * can, so the sign-in door refuses it and a session of it opened earlier does not resolve.
 *
 * WHEN MET. A session has met it when its stored data carries a record whose method is `passkey`,
 * or `dev` while this process's development switches are set (`devLoopDoorsOpen` — the development
 * door's own gate): a session the development door opened is worth nothing on a deployment that
 * sets neither switch. The stored data is read through the session store's own reader
 * (`DbSessionStore.liveSession`), under the store's expiry rule: a row that has lapsed is no
 * session, so it carries no record.
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

  /**
   * The relying party the factor's ceremonies run against, as the deployment declares it. Throws
   * where none is declared: no account must use a passkey there (`mustUse`), so no ceremony is
   * ever begun.
   */
  relyingParty(): RelyingParty {
    const declaration = getPasskeyRelyingParty();
    if (!declaration) {
      throw new Error('A passkey step needs a relying party, and this deployment declares none');
    }

    return declaration.getRelyingParty();
  }

  /** Whether the session's stored data carries a record that meets the factor on this process. */
  async sessionMet(sessionId: string): Promise<boolean> {
    if (!sessionId) {
      return false;
    }

    const session: Record<string, any> | undefined = await DbSessionStore.liveSession(sessionId);
    const method = session?.[SecondFactorGate.SESSION_KEY]?.method;
    return method === 'passkey' || (method === 'dev' && devLoopDoorsOpen(process.env));
  }
}
