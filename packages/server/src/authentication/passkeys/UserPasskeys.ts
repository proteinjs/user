import moment from 'moment';
import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { User, UserPasskey, tables } from '@proteinjs/user';
import { AccountSessions } from '../AccountSessions';
import { AuthChallenges } from './AuthChallenges';
import { CredentialUse, RegisteredCredential } from './WebAuthnVerifier';

/** An act on an account's passkeys, as its audit row names it. */
export type PasskeyAct = 'added' | 'removed' | 'reset';

/** The account an act on passkeys is made on: its id (the rows' scope) and its address (its sessions are bound to it). */
export type PasskeyAccount = Pick<User, 'id' | 'email'>;

/**
 * The ONE owner of the `user_passkey` rows: the table has no door on either api, so every read
 * and write of it is made here, as system, and nowhere else in the package.
 *
 * A read made as system gives up the scope column's own-rows filter, so the account is written
 * into every read and write here, in ONE place (`ofAccount`): no method reaches a row without
 * naming the account it belongs to, and an account's read never returns another account's rows.
 * A passkey a response names is read by the account AND the credential id together — the
 * credential id alone would let one account's passkey answer another account's challenge.
 *
 * AN ACT ON AN ACCOUNT'S PASSKEYS IS ONE TRANSACTION — a passkey added (`insertFirst`, `insert`),
 * one removed (`remove`), all of them reset (`removeAll`): the rows, the `user_account_event`
 * audit row that records the act (`record`: actor, target, field 'passkeys', the act as its value;
 * a passkey's name is never copied into it), and the sessions the act ends (`AccountSessions`)
 * commit together or not at all, so the trail cannot diverge from the rows and no session outlives
 * the passkey whose removal was meant to end it.
 */
export class UserPasskeys {
  /** The transports of a roaming security key: a passkey that reports only these is named for what it is. */
  private static readonly SECURITY_KEY_TRANSPORTS = ['usb', 'nfc', 'ble'];

  /** The account's passkeys, oldest first. */
  async forAccount(userId: string): Promise<UserPasskey[]> {
    const passkeys = await getDbAsSystem().query(tables.UserPasskey, this.ofAccount(userId));
    return passkeys.sort((a, b) => a.created.valueOf() - b.created.valueOf());
  }

  /** The account's passkey with this credential id, or undefined when the account has no such passkey. */
  async one(userId: string, credentialId: string): Promise<UserPasskey | undefined> {
    const passkeys = await getDbAsSystem().query(
      tables.UserPasskey,
      this.ofAccount(userId).condition({ field: 'credentialId', operator: '=', value: credentialId })
    );
    return passkeys[0];
  }

  /** How many passkeys the account has. */
  async count(userId: string): Promise<number> {
    return await getDbAsSystem().getRowCount(tables.UserPasskey, this.ofAccount(userId));
  }

  /**
   * Enroll the account's FIRST passkey, in one transaction: the account's passkeys are counted
   * again and anything but none refuses (resolves undefined, nothing written); the passkey is
   * inserted under the account's scope; the audit row is written (the account is its own actor);
   * and the account's other open register challenges are voided — so a registration begun before
   * the account enrolled, by whoever held its password then, enrolls nothing after.
   */
  async insertFirst(userId: string, credential: RegisteredCredential): Promise<UserPasskey | undefined> {
    const db = getDbAsSystem();
    return await db.runTransaction(async () => {
      if ((await db.getRowCount(tables.UserPasskey, this.ofAccount(userId))) !== 0) {
        return undefined;
      }

      const passkey = await db.insert(tables.UserPasskey, {
        ...credential,
        scope: userId,
        name: this.nameFor(credential.transports, []),
      });
      await this.record('added', userId, userId);
      await new AuthChallenges().voidOthers(userId, 'webauthn_register');
      return passkey;
    });
  }

  /**
   * Add a passkey to an account that already has one, in one transaction with its audit row (the
   * account is its own actor). The caller has proven a confirmation: nothing here asks again.
   */
  async insert(userId: string, credential: RegisteredCredential): Promise<UserPasskey> {
    const db = getDbAsSystem();
    return await db.runTransaction(async () => {
      const names = (await this.forAccount(userId)).map((passkey) => passkey.name);
      const passkey = await db.insert(tables.UserPasskey, {
        ...credential,
        scope: userId,
        name: this.nameFor(credential.transports, names),
      });
      await this.record('added', userId, userId);
      return passkey;
    });
  }

  /** Name the account's passkey `passkeyId`; resolves to whether the account has such a passkey. */
  async rename(userId: string, passkeyId: string, name: string): Promise<boolean> {
    return (await getDbAsSystem().update(tables.UserPasskey, { name }, this.oneOf(userId, passkeyId))) === 1;
  }

  /**
   * Remove the account's passkey `passkeyId`, in one transaction: the account's passkeys are
   * counted again and, where the account must keep one (`keepLast`), its last is refused; the row
   * is deleted; the audit row is written (the account is its own actor); and every session of the
   * account but `keepSessionId` ends — a device that held a session opened with the removed passkey
   * signs out, and the one the person removed it from stays. Resolves to what happened: `removed`,
   * `last` (refused: the account's only passkey) or `none` (the account has no such passkey);
   * nothing is written for the last two.
   */
  async remove(
    account: PasskeyAccount,
    passkeyId: string,
    options: { keepLast: boolean; keepSessionId: string }
  ): Promise<'removed' | 'last' | 'none'> {
    const db = getDbAsSystem();
    return await db.runTransaction(async () => {
      const passkeys = await this.forAccount(account.id);
      if (!passkeys.some((passkey) => passkey.id === passkeyId)) {
        return 'none';
      }
      if (options.keepLast && passkeys.length === 1) {
        return 'last';
      }

      await db.delete(tables.UserPasskey, this.oneOf(account.id, passkeyId));
      await this.record('removed', account.id, account.id);
      await new AccountSessions().endOthers(account.email, options.keepSessionId);
      return 'removed';
    });
  }

  /**
   * Reset the account's passkeys — `actor` is the admin who does — in one transaction: every
   * passkey of the account is deleted, every session of the account ends, and the audit row names
   * the actor and the account. Resolves to the number of passkeys removed; an account that has
   * none is left as it is (no session ended, no audit row: the trail records what happened).
   */
  async removeAll(account: PasskeyAccount, actor: string): Promise<number> {
    const db = getDbAsSystem();
    return await db.runTransaction(async () => {
      const removed = await db.delete(tables.UserPasskey, this.ofAccount(account.id));
      if (removed === 0) {
        return 0;
      }

      await new AccountSessions().endAll(account.email);
      await this.record('reset', actor, account.id);
      return removed;
    });
  }

  /** Record a verified use of the account's passkey: the counter, whether it is backed up, and now as its last use. */
  async used(passkey: UserPasskey, use: CredentialUse): Promise<void> {
    await getDbAsSystem().update(
      tables.UserPasskey,
      { ...use, lastUsedAt: moment() },
      this.oneOf(passkey.scope, passkey.id)
    );
  }

  /**
   * The record of an act on an account's passkeys: its audit row, written inside the act's
   * transaction. `actor` is the account itself for a person's own act.
   */
  private async record(act: PasskeyAct, actor: string, target: string): Promise<void> {
    await getDbAsSystem().insert(tables.UserAccountEvent, { actor, target, field: 'passkeys', value: act });
  }

  /** The rows of ONE account — the scope condition every read and write of the table starts from. */
  private ofAccount(userId: string) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('A passkey read names the account it is for: no account id was given');
    }

    return new QueryBuilderFactory()
      .getQueryBuilder<UserPasskey>(tables.UserPasskey)
      .condition({ field: 'scope', operator: '=', value: userId });
  }

  /** ONE row of one account, by its id — never a row by its id alone. */
  private oneOf(userId: string, passkeyId: string) {
    return this.ofAccount(userId).condition({ field: 'id', operator: '=', value: passkeyId });
  }

  /**
   * The name a new passkey is listed under until its owner renames it: what it is, with the next
   * free number when the account already lists that name.
   */
  private nameFor(transports: string[], taken: string[]): string {
    const securityKey =
      transports.length > 0 &&
      transports.every((transport) => UserPasskeys.SECURITY_KEY_TRANSPORTS.includes(transport));
    const base = securityKey ? 'Security key' : 'Passkey';
    let name = base;
    for (let number = 2; taken.includes(name); number++) {
      name = `${base} ${number}`;
    }

    return name;
  }
}
