import { getDbAsSystem } from '@proteinjs/db';
import { User, tables } from '@proteinjs/user';

/**
 * The ONE owner of "may this person reset that person's passkeys" — the recovery road when a
 * person has lost every passkey. A reset leaves an administrative account on its password alone
 * until its next sign-in, so the right is the `admin` role's alone (the door of `SetUserStatus`),
 * never the `users` permission's — whose holder could otherwise reset an admin's passkeys and then
 * take the account through its address. A reset is never of the caller's own account (a person's
 * own passkeys are removed one at a time, and never the last) and never of a declared machine
 * account (it signs in with its secret and holds no passkey).
 *
 * Asked wherever a reset is begun or done, so the two cannot disagree and a step that will be
 * refused is refused before anything is written or spent: by the reset's confirmation
 * (`Passkeys.beginConfirmation`, before its challenge is minted) and by the reset itself
 * (`PasskeyAdmin.reset`, before its confirmation is claimed). The reset service's door declares
 * the same role (`ROLE`).
 */
export class PasskeyResetGuard {
  /** The role a reset is open to. */
  static readonly ROLE = 'admin';

  /**
   * The account `caller` may reset the passkeys of, named by `userId`. Throws the refusal's words
   * otherwise. A caller who does not hold the right — as their account's roles stand now — is
   * refused before any account is read, so that refusal says nothing of whether `userId` names one.
   */
  async target(caller: Pick<User, 'id' | 'roles'>, userId: unknown): Promise<User> {
    if (!(caller.roles ?? []).includes(PasskeyResetGuard.ROLE)) {
      throw new Error('Only an admin can reset a person’s passkeys.');
    }

    const target =
      typeof userId === 'string' && userId ? await getDbAsSystem().get(tables.User, { id: userId }) : undefined;
    if (!target) {
      throw new Error(`No user found for id: ${userId}`);
    }
    if (target.id === caller.id) {
      throw new Error('You cannot reset your own passkeys. Remove one from your profile, or ask another admin.');
    }
    if (target.isLoadedFromSource === true) {
      throw new Error('This is a machine account: it signs in with its secret and has no passkeys.');
    }

    return target;
  }
}
