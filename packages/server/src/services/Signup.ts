import { getDbAsSystem } from '@proteinjs/db';
import {
  SendInviteResponse,
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
} from '@proteinjs/user';
import moment from 'moment';
import { lib } from 'crypto-js';
import { Logger } from '@proteinjs/logger';
import {
  EmailSender,
  getDefaultInviteEmailConfigFactory,
  getDefaultSignupConfirmationEmailConfigFactory,
} from '@proteinjs/email-server';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { PasswordHasher } from '../authentication/PasswordHasher';

/**
 * How long an invite link stays usable. Deliberately generous: a legitimate invite that gets
 * clicked late should still work, and revocation (surfaced in the admin UI) is the real control.
 * Expiry stays non-infinite so a forgotten invite isn't a permanent credential sitting in a mailbox.
 */
export const INVITE_TOKEN_TTL_DAYS = 90;

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

export class Signup implements SignupService {
  public serviceMetadata = {
    auth: {
      canAccess: (methodName: string, args: any[]) => {
        // Invite management rides the 'users' permission (admin passes via break-glass). This
        // previously evaluated the check WITHOUT returning it, which made sendInvite/revokeInvite
        // effectively public — any caller (even logged out) could mint themselves a valid signup
        // token and bypass invite-only signup.
        if (methodName === 'sendInvite' || methodName === 'revokeInvite') {
          return UserAuth.hasPermission(USER_PERMISSIONS.users);
        }

        return true;
      },
    },
  };

  async createUser(user: UserSignup, token?: string): Promise<void> {
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

    const defaultEmailConfigFactory = getDefaultSignupConfirmationEmailConfigFactory();
    const config = defaultEmailConfigFactory.getConfig();
    const emailSender = new EmailSender();

    const creation = await this.createAccount({
      name: user.name,
      email,
      password: user.password,
      emailVerified: invite ? true : false, // because we retrieved the email from the invite record
      invitedBy: invite ? invite.invitedBy : null,
    });
    if (creation === 'exists') {
      logger.error({ message: `User with this email already exists`, obj: { email } });
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
      return;
    }

    const { text, html } = config.getNewUserEmailContent();
    await emailSender.sendEmail({
      to: email,
      subject: config.newUserSubject || config.options?.subject || 'Welcome!',
      text,
      html,
      ...config.options,
    });
    logger.info({ message: `Created user`, obj: { email } });
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

      const emailSender = new EmailSender();
      const defaultConfigFactory = getDefaultInviteEmailConfigFactory();
      if (!defaultConfigFactory) {
        throw new Error(
          `Unable to find a @proteinjs/email-server/DefaultInviteEmailConfigFactory implementation when sending invite.`
        );
      }
      const config = defaultConfigFactory.getConfig();

      const token = lib.WordArray.random(32).toString();
      const tokenExpiresAt = moment().add(INVITE_TOKEN_TTL_DAYS, 'days');
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
          invitedBy: userId,
        });
      }

      const { text, html } = config.getEmailContent(`${uiRoutes.auth.signup}?token=${token}`);
      await emailSender.sendEmail({
        to: caseInsensitiveEmail,
        subject: config.options?.subject || `You're Invited`,
        text,
        html,
        ...config.options,
      });

      return { sent: true };
    } catch (error: any) {
      logger.error({ message: 'Error sending invite', obj: { email: caseInsensitiveEmail }, error });
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
   */
  async createAccount(account: {
    name: string;
    email: string;
    password: string;
    emailVerified: boolean;
    invitedBy: User['invitedBy'];
  }): Promise<'created' | 'exists'> {
    const db = getDbAsSystem();
    const email = account.email.toLowerCase();
    const existingUser = await db.get(tables.User, { email });
    if (existingUser) {
      return 'exists';
    }

    await db.insert(tables.User, {
      name: account.name,
      email,
      password: await new PasswordHasher().hash(account.password),
      emailVerified: account.emailVerified,
      roles: [],
      invitedBy: account.invitedBy,
    });
    return 'created';
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
}
