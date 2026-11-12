import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { PasskeyConfirmationPurpose, PasskeyConfirmationStep, User } from '@proteinjs/user';
import { SecondFactorGate } from '../SecondFactorGate';
import { AuthChallenges, SessionChallengeHolder } from './AuthChallenges';
import { UserPasskeys } from './UserPasskeys';
import { WebAuthnVerifier } from './WebAuthnVerifier';

/**
 * The ONE owner of "the person at this session has just proven one of their own passkeys, for
 * this act" — the confirmation every act on passkeys asks before it runs: adding one to an
 * account that has one, removing one, an admin's reset of another person's.
 *
 * A confirmation is two calls. `begin` mints a challenge bound to the account, the session and
 * the act (`AuthChallenges.mintInSession`; for a removal or a reset the challenge also names the
 * passkey or the person), and answers the options one of the account's passkeys signs. `confirms`
 * claims that challenge — single use, five minutes, answered only to the same account in the same
 * session for the same act — reads the passkey the assertion names by the account AND the
 * credential id, and verifies the assertion against the declared relying party with user
 * verification required (`WebAuthnVerifier`). So a confirmation made for one act confirms no
 * other, one made in another session or by another account confirms nothing, and one presented
 * twice confirms once. A refusal is one line naming the account by digest and the reason from the
 * verifier's closed list; the caller answers the person.
 */
export class PasskeyConfirmations {
  private readonly logger = new Logger({ name: 'PasskeyConfirmations' });
  private readonly challenges = new AuthChallenges();
  private readonly passkeys = new UserPasskeys();

  /**
   * Begin a confirmation of `purpose` by `account`, in the session `sessionId`: resolves to the
   * step one of the account's passkeys answers, or to undefined when the account has no passkey to
   * answer it with. A purpose that is not one of the three acts is refused in words.
   */
  async begin(
    account: Pick<User, 'id'>,
    sessionId: string,
    purpose: PasskeyConfirmationPurpose
  ): Promise<PasskeyConfirmationStep | undefined> {
    const holder = this.holder(account, sessionId, purpose);
    const subject = this.subjectOf(purpose);
    const passkeys = await this.passkeys.forAccount(account.id);
    if (passkeys.length === 0) {
      return undefined;
    }

    const options = await this.verifier().authenticationOptions(passkeys);
    const token = await this.challenges.mintInSession('webauthn_login', holder, options.challenge, { subject });
    return { token, options };
  }

  /**
   * Whether `confirmation` — the step's token with the assertion that answered it, as the client
   * sent them — confirms `purpose` for `account` in the session `sessionId`. The challenge is
   * spent by the asking, whatever the answer.
   */
  async confirms(
    account: Pick<User, 'id' | 'email'>,
    sessionId: string,
    purpose: PasskeyConfirmationPurpose,
    confirmation: unknown
  ): Promise<boolean> {
    const { token, assertion } = (confirmation ?? {}) as { token?: unknown; assertion?: unknown };
    const claimed = await this.challenges.claimInSession(
      token,
      'webauthn_login',
      this.holder(account, sessionId, purpose)
    );
    if (!claimed || claimed.subject !== this.subjectOf(purpose)) {
      return this.refused(account, purpose, 'no open confirmation of this act in this session');
    }

    const credentialId = WebAuthnVerifier.credentialIdOf(assertion);
    const passkey = credentialId ? await this.passkeys.one(account.id, credentialId) : undefined;
    if (!passkey) {
      return this.refused(account, purpose, 'the response names no passkey of this account');
    }

    const verdict = await this.verifier().verifyAuthentication(assertion, claimed.challenge, passkey);
    if (!verdict.verified) {
      return this.refused(account, purpose, verdict.reason);
    }

    await this.passkeys.used(passkey, verdict.use);
    return true;
  }

  /** One line for a confirmation that confirmed nothing: the account by digest, the act, the reason. */
  private refused(account: Pick<User, 'email'>, purpose: PasskeyConfirmationPurpose, reason: string): false {
    this.logger.info({
      message: 'Passkey confirmation refused',
      obj: { account: new RequestDigests().account(account.email), act: purpose.act, reason },
    });
    return false;
  }

  /** Who a confirmation's challenge is for: the account, the session, and the act as a challenge's purpose. */
  private holder(
    account: Pick<User, 'id'>,
    sessionId: string,
    purpose: PasskeyConfirmationPurpose
  ): SessionChallengeHolder {
    const purposes = { add: 'confirm-add', remove: 'confirm-remove', reset: 'confirm-reset' } as const;
    const act = purposes[purpose?.act];
    if (!act) {
      throw new Error('A confirmation is for adding a passkey, removing one, or resetting a person’s.');
    }

    return { userId: account.id, sessionId, purpose: act };
  }

  /** What the act is on — the passkey a removal names, the person a reset names; an add names nothing. */
  private subjectOf(purpose: PasskeyConfirmationPurpose): string | undefined {
    const subject = purpose.act === 'remove' ? purpose.passkeyId : purpose.act === 'reset' ? purpose.userId : undefined;
    if (purpose.act !== 'add' && (typeof subject !== 'string' || subject.length === 0)) {
      throw new Error('A confirmation of a removal names the passkey, and one of a reset names the person.');
    }

    return subject;
  }

  /** The verifier for the declared relying party (`SecondFactorGate.relyingParty` refuses where none is declared). */
  private verifier(): WebAuthnVerifier {
    return new WebAuthnVerifier(new SecondFactorGate().relyingParty());
  }
}
