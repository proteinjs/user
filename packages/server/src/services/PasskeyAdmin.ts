import { getDbAsSystem } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';
import { PasskeyAdminService, PasskeyConfirmation, User, tables } from '@proteinjs/user';
import { SignedInAccount } from '../authentication/SignedInAccount';
import { PasskeyResetGuard } from '../authorization/PasskeyResetGuard';
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
 * Who may reset whom is `PasskeyResetGuard`'s to say, and the reset asks it first — as the
 * reset's confirmation did when it was begun: a caller who does not hold the role, the caller's
 * own account and a declared machine account are refused before the confirmation is claimed, so
 * a refused reset spends nothing. Then the reset asks again: the admin's own passkey confirms it,
 * for exactly that person (`PasskeyConfirmations`). The reset itself is one transaction: the
 * passkeys deleted, the person's sessions ended, the audit row written (`UserPasskeys.removeAll`).
 */
export class PasskeyAdmin implements PasskeyAdminService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      roles: [PasskeyResetGuard.ROLE],
    },
  };

  async count(userId: string): Promise<number> {
    const account = await this.account(userId);
    return await new UserPasskeys().count(account.id);
  }

  async reset(userId: string, confirmation: PasskeyConfirmation): Promise<void> {
    const { account: admin, sessionId } = await new SignedInAccount().read();
    const target = await new PasskeyResetGuard().target(admin, userId);
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

  /** The account a count is of; a missing one is a refusal in words. */
  private async account(userId: string): Promise<User> {
    const user =
      typeof userId === 'string' && userId ? await getDbAsSystem().get(tables.User, { id: userId }) : undefined;
    if (!user) {
      throw new Error(`No user found for id: ${userId}`);
    }

    return user;
  }
}
