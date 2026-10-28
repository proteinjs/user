import { getDbAsSystem, Reference } from '@proteinjs/db';
import {
  SendInviteResponse,
  ResendEmailVerificationResponse,
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
}

/**
 * Result of resolving an invite token. `expired` is kept distinct from `notFound` so signup can
 * tell the user which one happened instead of a conflated "not found or expired".
 */
export type InviteLookup = { status: 'valid'; invite: Invite } | { status: 'expired' } | { status: 'notFound' };

export interface DefaultInviteConfigFactory extends Loadable {
  getConfig(): InviteConfig;
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
 */
export type CreateUserResult = {
  outcome: 'created' | 'exists';
  /** The account email, lowercased — resolved from the invite when a token was provided. */
  email: string;
};

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

        // The re-send is the signed-in account's own act: it reads the session's user and mails
        // that account, nobody else's.
        if (methodName === 'resendEmailVerification') {
          return UserAuth.isLoggedIn();
        }

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

    const creation = await this.createAccount({
      name: user.name,
      email,
      password: user.password,
      emailVerified: invite ? true : false, // because we retrieved the email from the invite record
      invitedBy: invite ? invite.invitedBy : null,
    });
    if (creation === 'exists') {
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

    // An invited address was proved by the invite mail; a plain sign-up's welcome carries the
    // link that confirms it (the account works meanwhile — nothing waits on the tap).
    const verification = invite ? undefined : await this.mintEmailVerification(email);
    try {
      await this.emailWelcome(emailSender, email, config, verification && { verifyEmailLink: verification.link });
    } catch (error) {
      // The link never reached the account: withdraw the token, so the account page's re-send
      // is not held by the gap between mails.
      if (verification) {
        await new EmailVerificationToken().revoke(verification.user, verification.token);
      }
      throw error;
    }
    logger.info({ message: `Created user`, obj: { account: new RequestDigests().account(email) } });
    return { outcome: 'created', email };
  }

  /**
   * The signed-in account's own re-send: a fresh token replaces the one outstanding (the earlier
   * link stops working) and the welcome-shaped mail goes out again with the new link, through the
   * same config as the sign-up's. Refused without a word — `{ sent: false }` — when the address is
   * already verified, when the last mint is inside the gap, or when the mail fails to send (the
   * token is withdrawn then, so the next tap is not held by the gap). The account is the
   * session's, read fresh from its row: a verification completed on another device is seen here.
   */
  async resendEmailVerification(): Promise<ResendEmailVerificationResponse> {
    const logger = new Logger({ name: 'Signup.resendEmailVerification' });
    const digests = new RequestDigests();
    const user = await getDbAsSystem().get(tables.User, { id: new UserRepo().getUser().id });
    if (!user || user.emailVerified) {
      return { sent: false };
    }

    const fields = { account: digests.account(user.email) };
    const verification = new EmailVerificationToken();
    const mintedAt = verification.mintedAt(user);
    if (mintedAt && moment().diff(mintedAt, 'minutes') < EMAIL_VERIFICATION_RESEND_GAP_MINUTES) {
      logger.info({ message: `Email verification re-send requested too soon`, obj: fields });
      return { sent: false };
    }

    const token = await verification.mint(user);
    try {
      await this.emailWelcome(new EmailSender(), user.email, this.signupConfirmationEmailConfig(), {
        verifyEmailLink: this.verifyEmailLink(token),
      });
    } catch (error: any) {
      logger.error({
        message: `Failed to send the email verification mail`,
        obj: fields,
        error: digests.redactError(error),
      });
      await verification.revoke(user, token);
      return { sent: false };
    }

    logger.info({ message: `Email verification link mailed`, obj: fields });
    return { sent: true };
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
          error: 'An invite is required to sign up.',
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
   * that refusal is the same fact the check reads, so the second answers 'exists' exactly as if it
   * had arrived a moment later: its caller gets the existing-address response, no session, and the
   * owner's mail — never the database's sentence, which names the address. An insert that fails
   * while the address still has no account is a real failure and throws.
   */
  async createAccount(account: {
    name: string;
    email: string;
    password: string;
    emailVerified: boolean;
    invitedBy: User['invitedBy'];
  }): Promise<'created' | 'exists'> {
    const email = account.email.toLowerCase();
    if (getMachineAccounts().some((machineAccount) => machineAccount.email === email)) {
      throw new Error(`This address can't be registered.`);
    }

    if (await this.hasAccount(email)) {
      return 'exists';
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
      if (await this.hasAccount(email)) {
        return 'exists';
      }
      throw error;
    }
    return 'created';
  }

  /** Whether an account holds `email` (already lowercased) — the one existence read `createAccount` makes. */
  private async hasAccount(email: string): Promise<boolean> {
    return Boolean(await getDbAsSystem().get(tables.User, { email }));
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
