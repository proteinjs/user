import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';
import { PasskeyAdminService, PasskeyConfirmation, User, tables } from '@proteinjs/user';
import { SignedInAccount } from '../authentication/SignedInAccount';
import { PasskeyConfirmations } from '../authentication/passkeys/PasskeyConfirmations';
import { UserPasskeys } from '../authentication/passkeys/UserPasskeys';

/**
 * An admin's acts on another person's passkeys (`PasskeyAdminService`): the count the account
 * page shows, and the reset that is the recovery road when a person has lost every passkey.
 *
 * Admin-only by explicit scope, the door of `SetUserStatus`: a reset leaves an administrative
 * account on its password alone until its next sign-in, so the door is the break-glass role, not
 * the `users` permission — whose holder could otherwise reset an admin's passkeys and then take
 * the account through its address.
 *
 * A reset asks again first: the admin's own passkey confirms it, for exactly that person
 * (`PasskeyConfirmations`). It is refused on the caller's own account (a person's own passkeys
 * are removed one at a time, and never the last) and on a declared machine account (it signs in
 * with its secret and holds no passkey) — both before the confirmation is spent. The reset itself
 * is one transaction: the passkeys deleted, the person's sessions ended, the audit row written
 * (`UserPasskeys.removeAll`).
 */
export class PasskeyAdmin implements PasskeyAdminService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      roles: ['admin'],
    },
  };

  async count(userId: string): Promise<number> {
    const target = await this.target(userId);
    return await new UserPasskeys().count(target.id);
  }

  async reset(userId: string, confirmation: PasskeyConfirmation): Promise<void> {
    const { account: admin, sessionId } = await new SignedInAccount().read();
    const target = await this.target(userId);
    if (target.id === admin.id) {
      throw new Error('You cannot reset your own passkeys. Remove one from your profile, or ask another admin.');
    }
    if (target.isLoadedFromSource === true) {
      throw new Error('This is a machine account: it signs in with its secret and has no passkeys.');
    }
    if (
      !(await new PasskeyConfirmations().confirms(admin, sessionId, { act: 'reset', userId: target.id }, confirmation))
    ) {
      throw new Error('Confirm with your passkey first.');
    }

    const removed = await new UserPasskeys().removeAll(target, admin.id);
    new Logger({ name: 'PasskeyAdmin.reset' }).info({
      message: 'Passkeys reset',
      obj: { actor: admin.id, target: target.id, removed },
    });
  }

  /** The account an act targets; a missing one is a refusal in words. */
  private async target(userId: string): Promise<User> {
    const user =
      typeof userId === 'string' && userId ? await getDbAsSystem().get(tables.User, { id: userId }) : undefined;
    if (!user) {
      throw new Error(`No user found for id: ${userId}`);
    }

    return user;
  }
}
