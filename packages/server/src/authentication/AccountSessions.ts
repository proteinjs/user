import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { tables } from '@proteinjs/user';

/**
 * The one owner of "this account's sessions end": the session rows bound to an address are
 * deleted (SocketIOSessionWatcher disconnects their sockets on the delete), so a cookie that
 * names one of them resolves to no session on its next request. Every by-account session end in
 * this package comes through here — a password reset or change (every other device signs out;
 * the device that changed it keeps its session), an address change (a session is bound to the
 * address it signed in with), a deactivation (`UserStatusTableWatcher`, which account deletion
 * also flips and ends through), a machine credential's rotation (`MachineCredentials`).
 *
 * Rows are matched on the account row's address, an exact equality: every door that mints a
 * session binds the address lowercased (`establishSession`), the account row holds it lowercased,
 * and the rows minted as typed before that door did were brought to the same form once
 * (`NormalizeSessionAddresses`), so the three agree.
 */
export class AccountSessions {
  /** End every session of the account; resolves to the number ended. */
  async endAll(email: string): Promise<number> {
    return await getDbAsSystem().delete(tables.Session, { userEmail: email });
  }

  /**
   * End every session of the account but `keepSessionId` — the one the person is acting from —
   * so a password change signs out every other device and not the one that made it. With no
   * session to keep (no request context), every session ends.
   */
  async endOthers(email: string, keepSessionId: string | undefined): Promise<number> {
    if (!keepSessionId) {
      return await this.endAll(email);
    }

    const others = new QueryBuilderFactory()
      .getQueryBuilder(tables.Session)
      .condition({ field: 'userEmail', operator: '=', value: email })
      .condition({ field: 'sessionId', operator: '!=', value: keepSessionId });
    return await getDbAsSystem().delete(tables.Session, others);
  }
}
