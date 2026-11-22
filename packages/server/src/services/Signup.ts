import { getDbAsSystem, Reference } from '@proteinjs/db';
import {
  SendInviteResponse,
  ResendEmailVerificationResponse,
  EmailConfirmationStateResponse,
  tables,
  UserAuth,
  uiRoutes,
  SignupService,
  InitializeSignupResponse,
  UserRepo,
  Invite,
  User,
  UserSignup,
  USER_PERMISSIONS,
  getMachineAccounts,
  SIGNUP_CLOSED_SENTENCE,
} from '@proteinjs/user';
import moment from 'moment';
import { lib } from 'crypto-js';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import {
  EmailSender,
  getDefaultInviteEmailConfigFactory,
  getDefaultSignupConfirmationEmailConfigFactory,
  InviteEmailConfig,
  SignupConfirmationEmailConfig,
  SignupConfirmationEmailContext,
} from '@proteinjs/email-server';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { EmailVerificationToken } from '../authentication/EmailVerificationToken';
import { PasswordHasher } from '../authentication/PasswordHasher';
import { getDefaultEmailConfirmationLinkEmailConfigFactory } from '../emails/EmailConfirmationLinkEmailConfig';
import { EmailConfirmation } from './EmailConfirmation';

/**
 * How long an invite link stays usable. Deliberately generous: a legitimate invite that gets
 * clicked late should still work, and revocation (surfaced in the admin UI) is the real control.
 * Expiry stays non-infinite so a forgotten invite isn't a permanent credential sitting in a mailbox.
 */
export const INVITE_TOKEN_TTL_DAYS = 90;

/**
 * The gap between two verification mails to one account — the password reset's five minutes:
 * long enough that a double tap sends one mail, short enough that a mistyped-looking inbox wait
 * ends soon.
 */
export const EMAIL_VERIFICATION_RESEND_GAP_MINUTES = 5;

export interface InviteConfig {
  isInviteOnly: boolean;
  /**
   * The sentence a person reads when an invite is required of them. Without it, the library's own
   * (`SIGNUP_CLOSED_SENTENCE`).
   */
  inviteRequiredSentence?: string;
}

/**
 * Result of resolving an invite token. `expired` is kept distinct from `notFound` so signup can
 * tell the user which one happened instead of a conflated "not found or expired".
 */
export type InviteLookup = { status: 'valid'; invite: Invite } | { status: 'expired' } | { status: 'notFound' };

export interface DefaultInviteConfigFactory extends Loadable {
  getConfig(): InviteConfig;
  /**
   * The rule for one address, asked of a sign-up that carries no invite before anything else is asked
   * of it (`Signup.inviteRequiredOf`). Optional: a product that registers only `getConfig` is asked
   * `getConfig` there, as it is everywhere else.
   */
  getConfigFor?(email: string): InviteConfig | Promise<InviteConfig>;
}

export const getDefaultInviteConfigFactory = (): DefaultInviteConfigFactory => {
  const defaultFactory: DefaultInviteConfigFactory = {
    getConfig: (): InviteConfig => ({ isInviteOnly: false }),
  };

  const factory = SourceRepository.get().object<DefaultInviteConfigFactory>(
    '@proteinjs/user-server/DefaultInviteConfigFactory'
  );
  return factory || defaultFactory;
};

/**
 * `createUser`'s outcome, for the signup route's eyes only (it never crosses the wire): the
 * route establishes a session on 'created' and must NOT on 'exists' — auto-login must never
 * hand out a session for an account the caller didn't just create. The response body stays
 * identical either way (existence is reported to the mailbox owner by email, not the caller).
 * 'startedOver' is a waiting account this sign-up took over (`createAccount`): the route
 * establishes the caller's session as for an account just made. With either of those two, `stored` is
 * the password as the account's row holds it once this sign-up wrote it: what the session the route
 * makes is held to (`PasswordSession`).
 */
export type CreateUserResult = {
  /** The account email, lowercased — resolved from the invite when a token was provided. */
  email: string;
} & AccountWrite;

/** What an account is made from (`Signup.createAccount`): the password as typed, hashed there. */
type NewAccount = {
  name: string;
  email: string;
  password: string;
  emailVerified: boolean;
  invitedBy: User['invitedBy'];
};

/** What writing an account answers: `stored` is the password as the row holds it once this write made or replaced it. */
type AccountWrite = { outcome: 'exists' } | { outcome: 'created' | 'startedOver'; stored: string };

export class Signup implements SignupService {
  public serviceMetadata = {
    auth: {
      canAccess: (methodName: string, args: any[]) => {
        // Invite management rides the 'users' permission (admin passes via break-glass). This
        // previously evaluated the check WITHOUT returning it, which made sendInvite/revokeInvite
        // effectively public — any caller (even logged out) could mint themselves a valid signup
        // token and bypass invite-only signup.
        if (methodName === 'sendInvite' || methodName === 'resendInvite' || methodName === 'revokeInvite') {
          return UserAuth.hasPermission(USER_PERMISSIONS.users);
        }

        // The re-send is the session's own account's: it reads the account of the session's address
        // and nobody else's. For a session that carries an address, never a visitor: where a product
        // holds an unconfirmed account back, its session answers as nobody (UserAuth.isLoggedIn is
        // false) and the re-send is what it can still ask for.
        if (methodName === 'resendEmailVerification') {
          return new EmailConfirmation().sessionAddress() !== undefined;
        }

        // The rest is anyone's to ask: the pre-submit initialization, and the question on coming back
        // (emailConfirmationState). That question too reads the account of the session's address and
        // nobody else's, and a request with no session is answered nobody with no read: so a waiting
        // screen whose session has ended somewhere else since it was painted learns it by asking.
        return true;
      },
    },
  };

  /**
   * The signup flow's account creation + notification emails. Not RPC-reachable (deliberately
   * absent from the SignupService interface): its caller is the `routes.signup` ROUTE, which
   * establishes the session (auto-login) from this result — a request-level concern services
   * never see.
   */
  async createUser(user: UserSignup, token?: string): Promise<CreateUserResult> {
    const logger = new Logger({ name: 'Signup.createUser' });
    const db = getDbAsSystem();

    const initSignupResponse = await this.initializeSignup(token);
    if (!initSignupResponse.isReady) {
      throw new Error(initSignupResponse.error);
    }

    // `initializeSignup` is the single place invite tokens are validated; reuse its result rather
    // than re-resolving the token here (two lookups meant two chances to disagree).
    const invite = initSignupResponse.invite ?? null;
    if (token) {
      await db.delete(tables.Invite, { token });
    }

    const email = (invite ? invite.email : user.email)?.toLowerCase();
    if (!email) {
      throw new Error('Email is required when there is no invite');
    }

    const config = this.signupConfirmationEmailConfig();
    const emailSender = new EmailSender();

    const creation = await this.writeAccount({
      name: user.name ?? '',
      email,
      password: user.password,
      emailVerified: invite ? true : false, // because we retrieved the email from the invite record
      invitedBy: invite ? invite.invitedBy : null,
    });
    if (creation.outcome === 'exists') {
      logger.error({
        message: `User with this email already exists`,
        obj: { account: new RequestDigests().account(email) },
      });
      if (config.getExistingUserEmailContent) {
        const { text, html } = config.getExistingUserEmailContent();
        await emailSender.sendEmail({
          to: email,
          subject: config.existingUserSubject || config.options?.subject || 'Account already exists',
          text,
          html,
          ...config.options,
        });
      }
      return { outcome: 'exists', email };
    }

    if (!invite && new EmailConfirmation().isRequired()) {
      // The mandatory confirmation: this sign-up gets ONE mail and it only confirms (the welcome goes
      // when the address is confirmed: routes/verifyEmail). Nothing is sent while a started-over
      // account's last link is inside the gap between mails: the one in the mailbox stands. A mail
      // that cannot be sent does not fail the sign-up: the account exists, and its screen re-sends.
      await this.mailVerificationLink(await db.get(tables.User, { email }));
      logger.info({
        message: creation.outcome === 'startedOver' ? `Started a waiting account over` : `Created user`,
        obj: { account: new RequestDigests().account(email) },
      });
      return { ...creation, email };
    }

    // An invited address was proved by the invite mail; a plain sign-up's welcome carries the
    // link that confirms it (the account works meanwhile — nothing waits on the tap). A welcome that
    // cannot be sent does not fail the sign-up: the account exists, and its person is signed in.
    const verification = invite ? undefined : await this.mintEmailVerification(email);
    try {
      await this.emailWelcome(emailSender, email, config, verification && { verifyEmailLink: verification.link });
    } catch (error: any) {
      const digests = new RequestDigests();
      logger.error({
        message: `Failed to send the welcome mail`,
        obj: { account: digests.account(email) },
        error: digests.redactError(error),
      });
      // The link never reached the account: withdraw the token, so the account page's re-send
      // is not held by the gap between mails.
      if (verification) {
        await new EmailVerificationToken().revoke(verification.user, verification.token);
      }
    }
    logger.info({ message: `Created user`, obj: { account: new RequestDigests().account(email) } });
    return { ...creation, email };
  }

  /**
   * Whether an invite is required of this address, asked by the sign-up route of a sign-up that carries
   * no invite, before the throwaway-mail list and the product's guard. The product's rule for one
   * address (`DefaultInviteConfigFactory.getConfigFor`) when it registers one, else its rule for
   * everyone. Answers the sentence the person reads when an invite is required, and undefined when it
   * is not. Not RPC-reachable (absent from the SignupService interface, as `createUser` is); a rule
   * that rejects rejects here, for the route to answer as it answers `createUser`'s failure.
   */
  async inviteRequiredOf(email: string): Promise<string | undefined> {
    const factory = getDefaultInviteConfigFactory();
    const config = factory.getConfigFor ? await factory.getConfigFor(email) : factory.getConfig();
    return config.isInviteOnly ? config.inviteRequiredSentence ?? SIGNUP_CLOSED_SENTENCE : undefined;
  }

  /**
   * The session's own account's re-send: one link mailed (`mailVerificationLink`: a fresh token
   * replaces the one outstanding, so the earlier link stops working). Not sent, with the reason, when
   * the address is already confirmed, when the last link was made inside the gap, or when the mail
   * fails to send. The account is the session's, read fresh from its row (a confirmation completed on
   * another device is seen here): the one that waits in this session where the product holds an
   * unconfirmed account back (`EmailConfirmation.waitingAccount`), else the signed-in one. A session
   * with neither is answered as a mail that could not be sent.
   */
  async resendEmailVerification(): Promise<ResendEmailVerificationResponse> {
    const user =
      (await new EmailConfirmation().waitingAccount()) ??
      (await getDbAsSystem().get(tables.User, { id: new UserRepo().getUser().id }));
    if (!user) {
      return { sent: false, whyNot: 'notSent' };
    }
    if (user.emailVerified === true) {
      return { sent: false, whyNot: 'alreadyConfirmed' };
    }

    const outcome = await this.mailVerificationLink(user);
    return outcome === 'sent' ? { sent: true } : { sent: false, whyNot: outcome };
  }

  /**
   * The question the confirmation's screen asks when it comes back to the front: does this session's
   * account still wait for its address to be confirmed? `waiting` while it is held back; `confirmed`
   * once the session answers as its account (the link was opened, here or elsewhere); `nobody` when
   * the session has no account to answer as, or the request carries no session at all (it has ended
   * since the screen was painted: by a log-out elsewhere, by its age, or by a sign-up that started
   * the account over).
   */
  async emailConfirmationState(): Promise<EmailConfirmationStateResponse> {
    if (await new EmailConfirmation().waitingAccount()) {
      return { state: 'waiting' };
    }

    return { state: UserAuth.isLoggedIn() ? 'confirmed' : 'nobody' };
  }

  /**
   * The welcome mail to an account whose address its link just confirmed (routes/verifyEmail), where
   * the product asks for the email confirmation: such a sign-up's own mail only confirmed. A welcome
   * that cannot be sent is logged and fails nothing. Not RPC-reachable (absent from the SignupService
   * interface, as `createUser` is).
   */
  async welcomeConfirmed(email: string): Promise<void> {
    try {
      await this.emailWelcome(new EmailSender(), email, this.signupConfirmationEmailConfig());
    } catch (error: any) {
      const digests = new RequestDigests();
      new Logger({ name: 'Signup.welcomeConfirmed' }).error({
        message: `Failed to send the welcome mail`,
        obj: { account: digests.account(email) },
        error: digests.redactError(error),
      });
    }
  }

  async sendInvite(email: string): Promise<SendInviteResponse> {
    const logger = new Logger({ name: 'Signup.sendInvite' });
    const caseInsensitiveEmail = email.toLowerCase();
    try {
      const db = getDbAsSystem();
      const userRecord = await db.get(tables.User, { email: caseInsensitiveEmail });
      if (userRecord) {
        return { sent: false, error: 'User already exists with that email.' };
      }

      const config = this.inviteEmailConfig();
      const { token, tokenExpiresAt } = this.mintInviteToken();
      let invite = await db.get(tables.Invite, { email: caseInsensitiveEmail });
      if (invite) {
        invite = {
          ...invite,
          token,
          tokenExpiresAt,
        };
        await db.update(tables.Invite, invite);
      } else {
        const userId = new UserRepo().getUser().id;
        invite = await db.insert(tables.Invite, {
          email: caseInsensitiveEmail,
          token,
          tokenExpiresAt,
          invitedBy: new Reference(tables.User.name, userId),
        });
      }

      await this.emailInvite(caseInsensitiveEmail, token, config);
      return { sent: true };
    } catch (error: any) {
      // The try block covers the Invite row's write and the mail: a refusal's own words may name
      // the address, so the error reaches the log through the digest door too.
      const digests = new RequestDigests();
      logger.error({
        message: 'Error sending invite',
        obj: { invitee: digests.address(caseInsensitiveEmail) },
        error: digests.redactError(error),
      });
      return {
        sent: false,
        error: 'Error occurred.',
      };
    }
  }

  /**
   * Re-sends a standing invite: the token in the earlier email stops working, a fresh token with
   * a fresh expiry takes its place on the same row (never a second row), and the invite email goes
   * out again through the same config. Refused when no invite stands for the address — there is
   * nothing to re-send — and when the address already has an account (the invite was used).
   * The inviter stays whoever sent it first.
   */
  async resendInvite(email: string): Promise<SendInviteResponse> {
    const logger = new Logger({ name: 'Signup.resendInvite' });
    const caseInsensitiveEmail = email.toLowerCase();
    try {
      const db = getDbAsSystem();
      const userRecord = await db.get(tables.User, { email: caseInsensitiveEmail });
      if (userRecord) {
        return { sent: false, error: 'User already exists with that email.' };
      }
      const invite = await db.get(tables.Invite, { email: caseInsensitiveEmail });
      if (!invite) {
        return { sent: false, error: 'No invite exists for that email.' };
      }

      const config = this.inviteEmailConfig();
      const { token, tokenExpiresAt } = this.mintInviteToken();
      await db.update(tables.Invite, { ...invite, token, tokenExpiresAt });
      await this.emailInvite(caseInsensitiveEmail, token, config);
      return { sent: true };
    } catch (error: any) {
      const digests = new RequestDigests();
      logger.error({
        message: 'Error re-sending invite',
        obj: { invitee: digests.address(caseInsensitiveEmail) },
        error: digests.redactError(error),
      });
      return {
        sent: false,
        error: 'Error occurred.',
      };
    }
  }

  async revokeInvite(email: string): Promise<void> {
    if (!email) {
      throw new Error('No email was provided.');
    }

    // The service door ('users' permission) is the wall; the write is the domain's own, so it
    // runs as system like every other invite write here — the invite table's db door stays admin.
    const db = getDbAsSystem();
    await db.delete(tables.Invite, { email: email.toLowerCase() });
  }

  /**
   * Initializes signup process, validating invite configuration and token if provided.
   * `DefaultInviteConfigFactory` defaults to invite optional.
   */
  async initializeSignup(inviteToken: string | undefined): Promise<InitializeSignupResponse> {
    try {
      const config = getDefaultInviteConfigFactory().getConfig();
      const { isInviteOnly } = config;

      // A bad token is reported whether or not signup is invite-only. Silently ignoring it left the
      // form rendered with the email field hidden (the UI hides it whenever a token is present),
      // so the user could only ever reach a generic "Sign up failed." on submit.
      if (inviteToken) {
        const lookup = await this.lookupInvite(inviteToken);
        if (lookup.status === 'expired') {
          return {
            isReady: false,
            error: 'This invite has expired. Ask whoever invited you to send a new one.',
            isInviteOnly,
          };
        }
        if (lookup.status === 'notFound') {
          return {
            isReady: false,
            error: 'This invite link is no longer valid. Ask whoever invited you to send a new one.',
            isInviteOnly,
          };
        }

        return {
          isReady: true,
          isInviteOnly,
          invite: lookup.invite,
        };
      }

      if (isInviteOnly) {
        return {
          isReady: false,
          error: SIGNUP_CLOSED_SENTENCE,
          isInviteOnly,
        };
      }

      return {
        isReady: true,
        isInviteOnly,
      };
    } catch (error: any) {
      return {
        isReady: false,
        error: 'Initializing sign up failed.',
      };
    }
  }

  /**
   * Single owner of account-record creation: case-normalized existence check + argon2id-hashed
   * insert (PasswordHasher). Both doors into a user row go through here — the signup flow (`createUser`, which
   * layers invite validation and confirmation emails on top) and the dev-login bootstrap
   * (`devLogin`, which auto-creates missing same-domain test accounts). Not exposed as an RPC:
   * the service surface is the `SignupService` INTERFACE (ServiceRouter walks its declared
   * methods), so extra class methods stay server-internal.
   *
   * An address a `MachineAccount` declaration owns is never registered, whatever its row state:
   * a person's row under it would make the boot sync refuse the declaration (it never takes over
   * a row it does not own), so the address is refused here in plain words — the declared machine
   * accounts of this build are the list, nothing else.
   *
   * 'exists' means the address has an account this call did not create — found by the check, or
   * written by a concurrent create between the check and this insert. Two creates for one address
   * both pass the check; the database's unique index on the address refuses the second insert, and
   * that refusal is the same fact the check reads, so the second is judged exactly as if it had
   * arrived a moment later (`existsOrStartsOver`): its caller gets the existing-address response, no
   * session, and the owner's mail — never the database's sentence, which names the address. An
   * insert that fails while the address still has no account is a real failure and throws.
   *
   * 'startedOver' is the mandatory email confirmation's answer for an address held by an account
   * that still waits (`existsOrStartsOver`): the account is now this caller's, as if just made.
   */
  async createAccount(account: NewAccount): Promise<'created' | 'exists' | 'startedOver'> {
    return (await this.writeAccount(account)).outcome;
  }

  /** `createAccount`, answering also the password as the row holds it once this write made or replaced it. */
  private async writeAccount(account: NewAccount): Promise<AccountWrite> {
    const email = account.email.toLowerCase();
    if (getMachineAccounts().some((machineAccount) => machineAccount.email === email)) {
      throw new Error(`This address can't be registered.`);
    }

    const held = await this.accountAt(email);
    if (held) {
      return await this.existsOrStartsOver(held, account);
    }

    const password = await new PasswordHasher().hash(account.password);
    try {
      await getDbAsSystem().insert(tables.User, {
        name: account.name,
        email,
        password,
        emailVerified: account.emailVerified,
        roles: [],
        invitedBy: account.invitedBy,
      });
    } catch (error: unknown) {
      const racedIn = await this.accountAt(email);
      if (racedIn) {
        return await this.existsOrStartsOver(racedIn, account);
      }
      throw error;
    }
    return { outcome: 'created', stored: password };
  }

  /** The account that holds `email` (already lowercased), if any — the one existence read `createAccount` makes. */
  private async accountAt(email: string): Promise<User | undefined> {
    return await getDbAsSystem().get(tables.User, { email });
  }

  /**
   * What a create answers for an address that has an account: 'exists', as ever, unless the address is
   * held by an account that still waits. Where the product asks for the email confirmation, a create
   * that would itself make an unconfirmed account (a sign-up without an invite) for an address whose
   * account is held back and not deactivated STARTS THAT ACCOUNT OVER: the name and the password this
   * sign-up carries replace the row's, and every session of the account ends. So a mistyped or
   * abandoned sign-up never blocks the person who really has the address, and nothing needs sweeping.
   * A confirmed account, a deactivated one, and every create that is not such a sign-up (an invite's,
   * the dev log-in's) are answered 'exists'.
   */
  private async existsOrStartsOver(
    held: User,
    account: { name: string; password: string; emailVerified: boolean }
  ): Promise<AccountWrite> {
    if (account.emailVerified || held.status === 'deactivated' || !new EmailConfirmation().holdsBack(held)) {
      return { outcome: 'exists' };
    }

    const db = getDbAsSystem();
    const password = await new PasswordHasher().hash(account.password);
    await db.update(tables.User, { id: held.id, name: account.name, password });
    await db.delete(tables.Session, { userEmail: held.email });
    return { outcome: 'startedOver', stored: password };
  }

  /** Resolves an invite token, distinguishing "expired" from "never existed / already revoked". */
  private async lookupInvite(token: string): Promise<InviteLookup> {
    const db = getDbAsSystem();
    const invite = await db.get(tables.Invite, { token });

    if (!invite) {
      return { status: 'notFound' };
    }

    if (invite.tokenExpiresAt && moment(invite.tokenExpiresAt).isBefore(moment())) {
      return { status: 'expired' };
    }

    return { status: 'valid', invite };
  }

  /** The invite email content factory the consumer registers; its absence is a misconfiguration, said aloud. */
  private inviteEmailConfig(): InviteEmailConfig {
    const defaultConfigFactory = getDefaultInviteEmailConfigFactory();
    if (!defaultConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/email-server/DefaultInviteEmailConfigFactory implementation when sending invite.`
      );
    }
    return defaultConfigFactory.getConfig();
  }

  /** A fresh redeemable token with its expiry from the TTL knob — the one minting path for send and re-send. */
  private mintInviteToken(): { token: string; tokenExpiresAt: moment.Moment } {
    return {
      token: lib.WordArray.random(32).toString(),
      tokenExpiresAt: moment().add(INVITE_TOKEN_TTL_DAYS, 'days'),
    };
  }

  /** The invite email itself — the signup link carrying `token`, rendered by the consumer's config. */
  private async emailInvite(email: string, token: string, config: InviteEmailConfig): Promise<void> {
    const { text, html } = config.getEmailContent(`${uiRoutes.auth.signup}?token=${token}`);
    await new EmailSender().sendEmail({
      to: email,
      subject: config.options?.subject || `You're Invited`,
      text,
      html,
      ...config.options,
    });
  }

  /** The sign-up mails' content factory: the consumer's registration, or the library's default. */
  private signupConfirmationEmailConfig(): SignupConfirmationEmailConfig {
    return getDefaultSignupConfirmationEmailConfigFactory().getConfig();
  }

  /**
   * The welcome mail — the new-user content from the config, handed the confirm link when the
   * address is unverified (an invited account's welcome carries no context).
   */
  private async emailWelcome(
    emailSender: EmailSender,
    email: string,
    config: SignupConfirmationEmailConfig,
    context?: SignupConfirmationEmailContext
  ): Promise<void> {
    const { text, html } = config.getNewUserEmailContent(context);
    await emailSender.sendEmail({
      to: email,
      subject: config.newUserSubject || config.options?.subject || 'Welcome!',
      text,
      html,
      ...config.options,
    });
  }

  /**
   * One link that confirms `user`'s address, mailed: a fresh token replaces the one outstanding (the
   * earlier link stops working) and the mail goes out with the new link. `tooSoon` when the last link
   * was made inside the gap: nothing is sent and that link stands, so no way of asking (a re-send, a
   * sign-up that starts a waiting account over) sends a second mail to one address inside it.
   * `notSent` when the mail fails to send: the token is withdrawn, so the next ask is not held by
   * the gap.
   */
  private async mailVerificationLink(user: User): Promise<'sent' | 'tooSoon' | 'notSent'> {
    const logger = new Logger({ name: 'Signup.mailVerificationLink' });
    const digests = new RequestDigests();
    const fields = { account: digests.account(user.email) };
    const verification = new EmailVerificationToken();
    const mintedAt = verification.mintedAt(user);
    if (mintedAt && moment().diff(mintedAt, 'minutes') < EMAIL_VERIFICATION_RESEND_GAP_MINUTES) {
      logger.info({ message: `Email verification link asked for too soon`, obj: fields });
      return 'tooSoon';
    }

    const token = await verification.mint(user);
    try {
      await this.emailVerificationLink(user.email, this.verifyEmailLink(token));
    } catch (error: any) {
      logger.error({
        message: `Failed to send the email verification mail`,
        obj: fields,
        error: digests.redactError(error),
      });
      await verification.revoke(user, token);
      return 'notSent';
    }

    logger.info({ message: `Email verification link mailed`, obj: fields });
    return 'sent';
  }

  /**
   * The mail that carries a confirm link: where the product asks for the email confirmation, the
   * confirmation's own mail (emails/EmailConfirmationLinkEmailConfig); else the welcome-shaped mail
   * with the link, through the sign-up's config, as before.
   */
  private async emailVerificationLink(email: string, link: string): Promise<void> {
    if (!new EmailConfirmation().isRequired()) {
      await this.emailWelcome(new EmailSender(), email, this.signupConfirmationEmailConfig(), {
        verifyEmailLink: link,
      });
      return;
    }

    const config = getDefaultEmailConfirmationLinkEmailConfigFactory().getConfig();
    const { text, html } = config.getEmailContent(link);
    await new EmailSender().sendEmail({ to: email, subject: config.subject, text, html });
  }

  /** A fresh verification token on the account's row, with the confirm link that carries it. */
  private async mintEmailVerification(email: string): Promise<{ user: User; token: string; link: string }> {
    const user = await getDbAsSystem().get(tables.User, { email });
    const token = await new EmailVerificationToken().mint(user);
    return { user, token, link: this.verifyEmailLink(token) };
  }

  /** The partial path a confirm link carries — the app's verify page with the token (not a full URL). */
  private verifyEmailLink(token: string): string {
    return `${uiRoutes.account.verifyEmail}?token=${token}`;
  }
}
