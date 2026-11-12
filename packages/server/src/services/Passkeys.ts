import { isDuplicateKeyError } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';
import {
  PasskeyAddStep,
  PasskeyConfirmation,
  PasskeyConfirmationPurpose,
  PasskeyConfirmationStep,
  PasskeyList,
  PasskeyView,
  PasskeysService,
  UserPasskey,
} from '@proteinjs/user';
import { SecondFactorGate } from '../authentication/SecondFactorGate';
import { SignedInAccount } from '../authentication/SignedInAccount';
import { AuthChallenges } from '../authentication/passkeys/AuthChallenges';
import { PasskeyConfirmations } from '../authentication/passkeys/PasskeyConfirmations';
import { UserPasskeys } from '../authentication/passkeys/UserPasskeys';
import { WebAuthnVerifier } from '../authentication/passkeys/WebAuthnVerifier';

/**
 * A person's own passkeys (`PasskeysService`). The account is ALWAYS the session's
 * (`SignedInAccount`: its row read fresh, its roles as they stand): no method takes an account
 * id, and every read and write goes through the passkey rows' one owner under that account's
 * scope (`UserPasskeys`), so nothing here reaches another account's passkeys.
 *
 * Adding is for an account that must use a passkey (`SecondFactorGate.mustUse` — the question's
 * one owner, which also answers `list().required`); passkeys for everyone else are not built. An
 * account's first passkey inside a session takes the first enrollment's own transaction (it adds
 * nothing if the account has gained one since the step began). Adding to an account that has one,
 * and removing one, ask again first (`PasskeyConfirmations`). Removing ends the account's other
 * sessions and refuses the last passkey of an account that must use one. Each act is one
 * transaction with its audit row (`UserPasskeys`).
 *
 * A refusal is thrown in words for the caller; none of them says whether a passkey id exists on
 * another account.
 */
export class Passkeys implements PasskeysService {
  /** Any signed-in account: every method acts on the caller's own passkeys alone. */
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      allUsers: true,
    },
  };

  /** The widest name a passkey takes: the `name` column's own width. */
  private static readonly NAME_MAX_LENGTH = 255;

  private static readonly CONFIRM_FIRST = 'Confirm with your passkey first.';
  private static readonly STEP_OVER = 'That step is over. Start again.';
  private static readonly NO_SUCH_PASSKEY = 'This account has no such passkey.';
  private static readonly LAST_PASSKEY =
    'This account signs in with a passkey, so it keeps at least one. Add another before removing this one.';

  private readonly logger = new Logger({ name: 'Passkeys' });
  private readonly gate = new SecondFactorGate();
  private readonly passkeys = new UserPasskeys();
  private readonly confirmations = new PasskeyConfirmations();
  private readonly challenges = new AuthChallenges();

  async list(): Promise<PasskeyList> {
    const { account } = await new SignedInAccount().read();
    const passkeys = await this.passkeys.forAccount(account.id);
    return { required: this.gate.mustUse(account), passkeys: passkeys.map((passkey) => this.view(passkey)) };
  }

  async beginConfirmation(purpose: PasskeyConfirmationPurpose): Promise<PasskeyConfirmationStep> {
    const { account, sessionId } = await new SignedInAccount().read();
    const step = await this.confirmations.begin(account, sessionId, purpose);
    if (!step) {
      throw new Error('This account has no passkey to confirm with.');
    }

    return step;
  }

  async beginAdd(confirmation?: PasskeyConfirmation): Promise<PasskeyAddStep> {
    const { account, sessionId } = await new SignedInAccount().read();
    this.refuseUnlessOwed(account);

    // An account that has a passkey proves one before it adds another; one that has none adds its
    // first as the first enrollment does, and the step remembers which it was.
    const passkeys = await this.passkeys.forAccount(account.id);
    const confirmed = passkeys.length > 0;
    if (confirmed && !(await this.confirmations.confirms(account, sessionId, { act: 'add' }, confirmation))) {
      throw new Error(Passkeys.CONFIRM_FIRST);
    }

    const options = await this.verifier().registrationOptions(account, passkeys);
    const token = await this.challenges.mintInSession(
      'webauthn_register',
      { userId: account.id, sessionId, purpose: 'add' },
      options.challenge,
      { confirmed }
    );
    return { token, options };
  }

  async finishAdd(token: string, registration: unknown): Promise<PasskeyView> {
    const { account, sessionId } = await new SignedInAccount().read();
    this.refuseUnlessOwed(account);
    const claimed = await this.challenges.claimInSession(token, 'webauthn_register', {
      userId: account.id,
      sessionId,
      purpose: 'add',
    });
    if (!claimed) {
      throw new Error(Passkeys.STEP_OVER);
    }

    const verdict = await this.verifier().verifyRegistration(registration, claimed.challenge);
    if (!verdict.verified) {
      this.logger.info({ message: 'Passkey add refused', obj: { account: account.id, reason: verdict.reason } });
      throw new Error('That passkey could not be added. Start again.');
    }

    let passkey: UserPasskey | undefined;
    try {
      // A step begun with no confirmation adds a FIRST passkey only: if the account has gained one
      // since, it adds nothing, and the person begins again — with a confirmation this time.
      passkey = claimed.confirmed
        ? await this.passkeys.insert(account.id, verdict.credential)
        : await this.passkeys.insertFirst(account.id, verdict.credential);
    } catch (error) {
      // A credential id is unique across accounts: one already enrolled, here or elsewhere, adds nothing.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      throw new Error('That passkey is already added.');
    }
    if (!passkey) {
      throw new Error(Passkeys.STEP_OVER);
    }

    this.logger.info({ message: 'Passkey added', obj: { account: account.id, passkey: passkey.id } });
    return this.view(passkey);
  }

  async rename(id: string, name: string): Promise<void> {
    const { account } = await new SignedInAccount().read();
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new Error('Enter a name.');
    }
    if (trimmed.length > Passkeys.NAME_MAX_LENGTH) {
      throw new Error(`A passkey’s name is at most ${Passkeys.NAME_MAX_LENGTH} characters.`);
    }
    if (!this.isId(id) || !(await this.passkeys.rename(account.id, id, trimmed))) {
      throw new Error(Passkeys.NO_SUCH_PASSKEY);
    }
  }

  async remove(id: string, confirmation: PasskeyConfirmation): Promise<void> {
    const { account, sessionId } = await new SignedInAccount().read();
    if (!this.isId(id)) {
      throw new Error(Passkeys.NO_SUCH_PASSKEY);
    }

    if (!(await this.confirmations.confirms(account, sessionId, { act: 'remove', passkeyId: id }, confirmation))) {
      throw new Error(Passkeys.CONFIRM_FIRST);
    }

    // An account that must use a passkey keeps one: the removal's own transaction counts them.
    const keepLast = this.gate.mustUse(account);
    const outcome = await this.passkeys.remove(account, id, { keepLast, keepSessionId: sessionId });
    if (outcome === 'last') {
      throw new Error(Passkeys.LAST_PASSKEY);
    }
    if (outcome === 'none') {
      throw new Error(Passkeys.NO_SUCH_PASSKEY);
    }

    this.logger.info({ message: 'Passkey removed', obj: { account: account.id, passkey: id } });
  }

  /** Adding a passkey is for an account that must use one; any other is refused in words. */
  private refuseUnlessOwed(account: Parameters<SecondFactorGate['mustUse']>[0]): void {
    if (!this.gate.mustUse(account)) {
      throw new Error('Passkeys are for accounts that sign in with one.');
    }
  }

  /** The verifier for the declared relying party, whose values are the gate's to hand out. */
  private verifier(): WebAuthnVerifier {
    return new WebAuthnVerifier(this.gate.relyingParty());
  }

  /** A passkey as its owner's list shows it: no key, no credential id. */
  private view(passkey: UserPasskey): PasskeyView {
    return {
      id: passkey.id,
      name: passkey.name,
      created: passkey.created,
      lastUsedAt: passkey.lastUsedAt ?? null,
      backedUp: passkey.backedUp,
    };
  }

  /** Whether a client's value is a row id's shape: text, and not blank — never anything else as a filter. */
  private isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
  }
}
