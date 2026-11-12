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
 * (`PasskeyAdmin.reset`, before its confirmation is claimed) — and where an admin's page asks
 * whether to offer the reset at all (`PasskeyAdmin.count`, `mayReset`), so the page keeps no copy
 * of the rule. The reset service's door declares the same role (`ROLE`).
 */
export class PasskeyResetGuard {
  /** The role a reset is open to. */
  static readonly ROLE = 'admin';

  private static readonly NOT_AN_ADMIN = 'Only an admin can reset a person’s passkeys.';

  /**
   * The account `caller` may reset the passkeys of, named by `userId`. Throws the refusal's words
   * otherwise. A caller who does not hold the right — as their account's roles stand now — is
   * refused before any account is read, so that refusal says nothing of whether `userId` names one.
   */
  async target(caller: Pick<User, 'id' | 'roles'>, userId: unknown): Promise<User> {
    if (!this.holdsTheRole(caller)) {
      throw new Error(PasskeyResetGuard.NOT_AN_ADMIN);
    }

    const target =
      typeof userId === 'string' && userId ? await getDbAsSystem().get(tables.User, { id: userId }) : undefined;
    if (!target) {
      throw new Error(`No user found for id: ${userId}`);
    }
    const refusal = this.refusal(caller, target);
    if (refusal) {
      throw new Error(refusal);
    }

    return target;
  }

  /**
   * Whether `caller` may reset the passkeys of `target` — the rule `target` refuses by, over an
   * account the asker has already read. A caller with no account row (the built-in default admin)
   * may not: the reset itself refuses one (`SignedInAccount.read`).
   */
  mayReset(caller: Pick<User, 'id' | 'roles'> | undefined, target: Pick<User, 'id' | 'isLoadedFromSource'>): boolean {
    return caller !== undefined && this.refusal(caller, target) === undefined;
  }

  /** Why `caller` may not reset the passkeys of `target`, in the refusal's words; undefined when they may. */
  private refusal(
    caller: Pick<User, 'id' | 'roles'>,
    target: Pick<User, 'id' | 'isLoadedFromSource'>
  ): string | undefined {
    if (!this.holdsTheRole(caller)) {
      return PasskeyResetGuard.NOT_AN_ADMIN;
    }
    if (target.id === caller.id) {
      return 'You cannot reset your own passkeys. Remove one from your profile, or ask another admin.';
    }
    if (target.isLoadedFromSource === true) {
      return 'This is a machine account: it signs in with its secret and has no passkeys.';
    }

    return undefined;
  }

  private holdsTheRole(caller: Pick<User, 'roles'>): boolean {
    return (caller.roles ?? []).includes(PasskeyResetGuard.ROLE);
  }
}
