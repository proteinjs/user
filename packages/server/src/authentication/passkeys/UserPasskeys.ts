import moment from 'moment';
import { getDbAsSystem, isDuplicateKeyError, QueryBuilderFactory } from '@proteinjs/db';
import { User, UserPasskey, tables } from '@proteinjs/user';
import { PasskeyChange } from '../../emails/PasskeyChangedEmailConfig';
import { PasskeyEmails } from '../../emails/PasskeyEmails';
import { AccountSessions } from '../AccountSessions';
import { AuthChallenges } from './AuthChallenges';
import { CredentialUse, RegisteredCredential, WebAuthnVerifier } from './WebAuthnVerifier';

/** The account an act on passkeys is made on: its id (the rows' scope) and its address (its sessions are bound to it). */
export type PasskeyAccount = Pick<User, 'id' | 'email'>;

/**
 * What an assertion came to: the account's passkey that answered it, or the reason none did — a
 * reason from the verifier's closed list, never the response's own text.
 */
export type PasskeyAssertion = { passkey: UserPasskey } | { refused: string };

/**
 * What an enrollment came to: the passkey it wrote, or why it wrote nothing — `not-first`, a first
 * enrollment for an account that has gained a passkey since its step began; `taken`, a credential
 * that is already a passkey, on this account or another.
 */
export type PasskeyEnrollment = { passkey: UserPasskey } | { refused: 'not-first' | 'taken' };

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
 * AN ASSERTION BY ONE OF THE ACCOUNT'S OWN PASSKEYS is sequenced here, once (`asserted`): it is a
 * read of the account's row, a verification against that row's key and a write of the use it
 * proved, so it belongs to the rows' owner — the verifier stays what it is, the library's wrapper
 * for one relying party, handed the row and reading no table. The sign-in's passkey step and a
 * confirmation of an act both ask it, so neither can drop a step the other keeps.
 *
 * AN ACT ON AN ACCOUNT'S PASSKEYS IS ONE TRANSACTION — a passkey added (`insertFirst`, `insert`),
 * one removed (`remove`), all of them reset (`removeAll`): the rows, the `user_account_event`
 * audit row that records the act (`record`: actor, target, field 'passkeys', the act as its value;
 * a passkey's name is never copied into it), and the sessions the act ends (`AccountSessions`)
 * commit together or not at all, so the trail cannot diverge from the rows and no session outlives
 * the passkey whose removal was meant to end it. Once it has committed — and only then — the
 * account is told of it by mail (`PasskeyEmails`): an act that rolled back mails nothing, and a
 * mail that cannot be sent undoes nothing.
 */
export class UserPasskeys {
  /** The transports of a roaming security key: a passkey that reports only these is named for what it is. */
  private static readonly SECURITY_KEY_TRANSPORTS = ['usb', 'nfc', 'ble'];

  /** The account's passkeys, oldest first. */
  async forAccount(userId: string): Promise<UserPasskey[]> {
    const passkeys = await getDbAsSystem().query(tables.UserPasskey, this.ofAccount(userId));
    return passkeys.sort((a, b) => a.created.valueOf() - b.created.valueOf());
  }

  /** How many passkeys the account has. */
  async count(userId: string): Promise<number> {
    return await getDbAsSystem().getRowCount(tables.UserPasskey, this.ofAccount(userId));
  }

  /**
   * An assertion by one of the account's own passkeys, made for `challenge`: the credential id
   * `response` names is read in a credential id's shape before it becomes a filter; the passkey is
   * read by the account AND that credential id; the response is verified against that row's key,
   * for the declared relying party, with user verification required (`WebAuthnVerifier`); and the
   * use it proved is recorded — the counter, whether it is backed up, and now as its last use.
   * Resolves to the passkey that answered, or to why none did.
   */
  async asserted(userId: string, response: unknown, challenge: string): Promise<PasskeyAssertion> {
    const credentialId = WebAuthnVerifier.credentialIdOf(response);
    const passkey = credentialId ? await this.one(userId, credentialId) : undefined;
    if (!passkey) {
      return { refused: 'the response names no passkey of this account' };
    }

    const verifier = WebAuthnVerifier.forDeclaredRelyingParty();
    const verdict = await verifier.verifyAuthentication(response, challenge, passkey);
    if (!verdict.verified) {
      return { refused: verdict.reason };
    }

    await this.used(passkey, verdict.use);
    return { passkey };
  }

  /**
   * Enroll the account's FIRST passkey, in one transaction: the account's passkeys are counted
   * again and anything but none refuses (`not-first`, nothing written); the passkey is inserted
   * under the account's scope; the audit row is written (the account is its own actor); and the
   * account's other open register challenges are voided — so a registration begun before the
   * account enrolled, by whoever held its password then, enrolls nothing after.
   */
  async insertFirst(userId: string, credential: RegisteredCredential): Promise<PasskeyEnrollment> {
    const db = getDbAsSystem();
    return await this.enrollment(async () => {
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
  async insert(userId: string, credential: RegisteredCredential): Promise<PasskeyEnrollment> {
    const db = getDbAsSystem();
    return await this.enrollment(async () => {
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

  /**
   * One enrollment: `write` is its transaction, resolving to the passkey it inserted or to
   * undefined when it found the account already has one. A credential id is unique across
   * accounts, so a credential that is already a passkey — here or on another account — is refused
   * by the table's own key: that refusal, and only that one, is answered `taken`, with nothing
   * written. Any other failure is the caller's to see, as any failure is.
   */
  private async enrollment(write: () => Promise<UserPasskey | undefined>): Promise<PasskeyEnrollment> {
    let passkey: UserPasskey | undefined;
    try {
      passkey = await getDbAsSystem().runTransaction(write);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      return { refused: 'taken' };
    }

    return passkey ? { passkey } : { refused: 'not-first' };
  }

  /** The account's passkey with this credential id, or undefined when the account has no such passkey. */
  private async one(userId: string, credentialId: string): Promise<UserPasskey | undefined> {
    const passkeys = await getDbAsSystem().query(
      tables.UserPasskey,
      this.ofAccount(userId).condition({ field: 'credentialId', operator: '=', value: credentialId })
    );
    return passkeys[0];
  }

  /** Record a verified use of the account's passkey: the counter, whether it is backed up, and now as its last use. */
  private async used(passkey: UserPasskey, use: CredentialUse): Promise<void> {
    await getDbAsSystem().update(
      tables.UserPasskey,
      { ...use, lastUsedAt: moment() },
      this.oneOf(passkey.scope, passkey.id)
    );
  }

  /**
   * The record of an act on an account's passkeys: its audit row, written inside the act's
   * transaction, and the mail that tells the account of it, queued to go once that transaction
   * has committed. `actor` is the account itself for a person's own act.
   */
  private async record(act: PasskeyChange, actor: string, target: string): Promise<void> {
    const db = getDbAsSystem();
    await db.insert(tables.UserAccountEvent, { actor, target, field: 'passkeys', value: act });
    await db.runAfterCommit(async () => await new PasskeyEmails().tell(target, act));
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
