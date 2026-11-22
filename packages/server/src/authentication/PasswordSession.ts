import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { establishSession } from './establishSession';
import { PasswordHasher } from './PasswordHasher';

/**
 * A SESSION MADE ON A PASSWORD: the one the log-in makes for the password it judged, and the one the
 * sign-up makes for the password it stored. Such a session stands only if the account still holds that
 * password once the session is saved; one that does not is ended in the same request, before its door
 * answers.
 *
 * So whatever replaces an account's password and then ends the account's sessions (a sign-up that starts
 * a waiting account over, `Signup.createAccount`) leaves no session made on the earlier password, in any
 * order of the two: either it wrote the password before this reads the account, and this ends the
 * session; or it ended the account's sessions after this one was saved, and ended this one with them. The
 * session store keeps an ended session ended (`DbSessionStore`).
 *
 * The account is read once, after the save, and the password its row holds is compared with the one the
 * door kept from its own judgment or write: the password is not judged a second time. Only where the two
 * differ is the typed password judged against the row as it stands, so an account whose password was
 * only stored anew meanwhile (the log-in's own re-hash of an older format, by a second log-in at the same
 * moment; the same password signed up twice) still holds it.
 */
export class PasswordSession {
  /**
   * @param email the account's address
   * @param password `stored`: the password as the account's row held it when the door judged or wrote
   *   it; `typed`: the password the request carried
   */
  constructor(
    private email: string,
    private password: { stored: string; typed: string }
  ) {}

  /**
   * Makes the session (`establishSession`) and resolves to whether it stands. A session that does not
   * stand is ended here, the way the log-out route ends one, and so is one whose account cannot be read
   * to tell: that read's failure rejects, with no session left behind it.
   */
  async establish(request: any): Promise<boolean> {
    await establishSession(request, this.email);
    let holds: boolean;
    try {
      holds = await this.accountStillHolds();
    } catch (error) {
      await this.end(request);
      throw error;
    }

    if (!holds) {
      await this.end(request);
    }
    return holds;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Whether the account's row still holds the password this session was made on. */
  private async accountStillHolds(): Promise<boolean> {
    const account = await getDbAsSystem().get(tables.User, { email: this.email.toLowerCase() });
    if (!account) {
      return false;
    }

    return (
      account.password === this.password.stored ||
      (await new PasswordHasher().verify(account.password, this.password.typed))
    );
  }

  /**
   * Ends the session this request just made: passport's own `request.logout` clears the account from
   * the session and regenerates its id, and the regenerate removes the session's row through the store
   * (routes/logout).
   */
  private async end(request: any): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      request.logout((error: unknown) => (error ? reject(error) : resolve()))
    );
  }
}
