import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';
import { tables, User, UserAccountAdminService, UserRepo, USER_PERMISSIONS } from '@proteinjs/user';
import { emailRegex } from '@proteinjs/util';
import { RequestDigests } from '@proteinjs/util-node';
import { AccountSessions } from '../authentication/AccountSessions';
import { AdministrativeAccountGuard } from '../authorization/AdministrativeAccountGuard';

/** The cells this service writes, each with its audit word. */
type AccountCell = 'name' | 'email' | 'emailVerified';

/**
 * The ONE write path a client has to ANOTHER account's plain cells — name, email, email-verified
 * (the user table has no generic write door: every `DbService` write on it is refused, so a user
 * manager's edits come through here or not at all). Each change and its `user_account_event`
 * audit row (actor, target, field; `created` is the timestamp) commit in one transaction, so the
 * trail cannot diverge from the cells; a change to what the row already holds writes nothing.
 *
 * An address change is an identity change: the new address is unverified until its owner
 * confirms it through the account page's re-send (`SignupService.resendEmailVerification`, the
 * one mailed road — this service mails nothing), the outstanding verification token is cleared,
 * and every session of the account ends (a session is bound to the address it signed in with,
 * and would otherwise resolve to nobody on its next request). A machine account's address is its
 * declaration's and is refused here. The door is the `users` permission — the trust that reads
 * these rows; the audit table opens to the same.
 *
 * Whoever holds an account's address holds the account (the reset link is mailed there), so the
 * address of an account that holds an administrative role is the `admin` role's to change, never
 * the `users` door's alone — asked of `AdministrativeAccountGuard`, the question's one owner: the
 * refusal is the caller's to read and a log line's to keep, as the Roles service's refusals are;
 * it writes nothing.
 */
export class UserAccountAdmin implements UserAccountAdminService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      permission: USER_PERMISSIONS.users,
    },
  };

  async setName(userId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Enter a name.');
    }

    const user = await this.target(userId);
    if (user.name === trimmed) {
      return;
    }

    await this.write(user, 'name', { name: trimmed }, null);
  }

  async setEmail(userId: string, email: string): Promise<void> {
    const logger = new Logger({ name: 'UserAccountAdmin.setEmail' });
    const digests = new RequestDigests();
    const address = email.trim().toLowerCase();
    if (!emailRegex.test(address)) {
      throw new Error('Enter a valid email address.');
    }

    const user = await this.target(userId);
    if (user.isLoadedFromSource === true || user.machine === true) {
      throw new Error(
        `This is a machine account: its address is declared in code (its MachineAccount declaration). ` +
          `Change the declaration instead.`
      );
    }

    // Asked BEFORE the no-change return, so the refusal is always an error the caller sees.
    new AdministrativeAccountGuard().refuseUnlessAllowed('address change', { id: user.id, roles: user.roles ?? [] });

    if (user.email === address) {
      return;
    }

    const db = getDbAsSystem();
    if (await db.get(tables.User, { email: address })) {
      throw new Error('Another account already uses that email address.');
    }

    try {
      // The address, un-verified: the person confirms the new one through the mailed road.
      await this.write(
        user,
        'email',
        { email: address, emailVerified: false, emailVerificationToken: null, emailVerificationTokenExpiration: null },
        null
      );
    } catch (error: unknown) {
      // A concurrent write under the unique address index refuses in the database's words, which
      // name the address: the log gets them through the digest door, the caller a plain sentence.
      logger.error({ message: 'Account email change failed', error: digests.redactError(error) });
      throw new Error('That email address could not be set. Try again.');
    }

    // Bound to the old address, the sessions would resolve to nobody; ended here, they say so.
    const sessionsEnded = await new AccountSessions().endAll(user.email);
    logger.info({
      message: 'Account email changed',
      obj: {
        actor: new UserRepo().getUser().id,
        target: userId,
        from: digests.account(user.email),
        to: digests.account(address),
        sessionsEnded,
      },
    });
  }

  async setEmailVerified(userId: string, verified: boolean): Promise<void> {
    const user = await this.target(userId);
    if ((user.emailVerified === true) === verified) {
      return;
    }

    // A confirmed address needs no pending link; an un-confirmed one gets a fresh link from the re-send.
    await this.write(
      user,
      'emailVerified',
      { emailVerified: verified, emailVerificationToken: null, emailVerificationTokenExpiration: null },
      String(verified)
    );
  }

  /** The account a change targets; a missing one is a refusal in words. */
  private async target(userId: string): Promise<User> {
    const user = await getDbAsSystem().get(tables.User, { id: userId });
    if (!user) {
      throw new Error(`No user found for id: ${userId}`);
    }

    return user;
  }

  /** The cell write and its audit row, in one transaction; `value` is the row's non-personal written value or null. */
  private async write(user: User, field: AccountCell, changes: Partial<User>, value: string | null): Promise<void> {
    const actor = new UserRepo().getUser();
    const db = getDbAsSystem();
    await db.runTransaction(async () => {
      await db.update(tables.User, { id: user.id, ...changes });
      await db.insert(tables.UserAccountEvent, { actor: actor.id, target: user.id, field, value });
    });
    new Logger({ name: 'UserAccountAdmin' }).info({
      message: `Account ${field} changed`,
      obj: { actor: actor.id, target: user.id, field },
    });
  }
}
