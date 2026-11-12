import { getDbAsSystem } from '@proteinjs/db';
import { Session } from '@proteinjs/server-api';
import { User, UserRepo, tables } from '@proteinjs/user';

/**
 * Who a service call that acts on the caller's own sign-in is made as: the session's account,
 * read FRESH from its row (the session cache holds the row as it stood when the request began;
 * the roles decide what a passkey act may do), and the id of the session the call rides — what a
 * challenge made inside a session is bound to, and the session an act keeps when it ends the
 * account's others.
 */
export class SignedInAccount {
  /**
   * The caller's account row and session id. Refused in words for a caller with no account row
   * (a guest; the built-in default admin, which has none) and for a call that rides no session.
   */
  async read(): Promise<{ account: User; sessionId: string }> {
    const account = await this.account();
    const sessionId = Session.getData()?.sessionId;
    if (!account || typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Sign in to manage passkeys.');
    }

    return { account, sessionId };
  }

  /**
   * The caller's account row, read fresh; undefined for a caller with no account row (a guest; the
   * built-in default admin). For a question about the caller that has an answer without a row —
   * whether the caller may reset a person's passkeys (`PasskeyAdmin.count`) is no for one; an act
   * on the caller's own sign-in asks `read`, which refuses one.
   */
  async account(): Promise<User | undefined> {
    const sessionUser = new UserRepo().getUser();
    return sessionUser?.id ? await getDbAsSystem().get(tables.User, { id: sessionUser.id }) : undefined;
  }
}
