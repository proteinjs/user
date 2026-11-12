import moment from 'moment';
import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { UserPasskey, tables } from '@proteinjs/user';
import { AuthChallenges } from './AuthChallenges';
import { CredentialUse, RegisteredCredential } from './WebAuthnVerifier';

/**
 * The ONE owner of the `user_passkey` rows: the table has no door on either api, so every read
 * and write of it is made here, as system, and nowhere else in the package.
 *
 * A read made as system gives up the scope column's own-rows filter, so the account is written
 * into every read and write here, in ONE place (`ofAccount`): no method reaches a row without
 * naming the account it belongs to, and an account's read never returns another account's rows.
 * A passkey a response names is read by the account AND the credential id together — the
 * credential id alone would let one account's passkey answer another account's challenge.
 */
export class UserPasskeys {
  /** The transports of a roaming security key: a passkey that reports only these is named for what it is. */
  private static readonly SECURITY_KEY_TRANSPORTS = ['usb', 'nfc', 'ble'];

  /** The account's passkeys. */
  async forAccount(userId: string): Promise<UserPasskey[]> {
    return await getDbAsSystem().query(tables.UserPasskey, this.ofAccount(userId));
  }

  /** The account's passkey with this credential id, or undefined when the account has no such passkey. */
  async one(userId: string, credentialId: string): Promise<UserPasskey | undefined> {
    const passkeys = await getDbAsSystem().query(
      tables.UserPasskey,
      this.ofAccount(userId).condition({ field: 'credentialId', operator: '=', value: credentialId })
    );
    return passkeys[0];
  }

  /**
   * Enroll the account's FIRST passkey, in one transaction: the account's passkeys are counted
   * again and anything but none refuses (resolves undefined, nothing written); the passkey is
   * inserted under the account's scope; the audit row is written (the account is its own actor;
   * the passkey's name is not copied); and the account's other open register challenges are
   * voided — so a registration begun before the account enrolled, by whoever held its password
   * then, enrolls nothing after.
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
        name: this.nameFor(credential.transports),
      });
      await db.insert(tables.UserAccountEvent, { actor: userId, target: userId, field: 'passkeys', value: 'added' });
      await new AuthChallenges().voidOthers(userId, 'webauthn_register');
      return passkey;
    });
  }

  /** Record a verified use of the account's passkey: the counter, whether it is backed up, and now as its last use. */
  async used(passkey: UserPasskey, use: CredentialUse): Promise<void> {
    await getDbAsSystem().update(
      tables.UserPasskey,
      { ...use, lastUsedAt: moment() },
      this.ofAccount(passkey.scope).condition({ field: 'id', operator: '=', value: passkey.id })
    );
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

  /** The name a new passkey is listed under until its owner renames it. */
  private nameFor(transports: string[]): string {
    const securityKey =
      transports.length > 0 &&
      transports.every((transport) => UserPasskeys.SECURITY_KEY_TRANSPORTS.includes(transport));
    return securityKey ? 'Security key' : 'Passkey';
  }
}
