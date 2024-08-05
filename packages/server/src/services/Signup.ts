import { getDb, getDbAsSystem } from '@proteinjs/db';
import {
  SendInviteResponse,
  tables,
  UserAuth,
  uiRoutes,
  SignupService,
  InitializeSignupResponse,
  UserRepo,
  Invite,
  UserSignup,
} from '@proteinjs/user';
import moment from 'moment';
import { lib } from 'crypto-js';
import { Logger } from '@proteinjs/util';
import {
  EmailSender,
  getDefaultInviteEmailConfigFactory,
  getDefaultSignupConfirmationEmailConfigFactory,
} from '@proteinjs/email-server';
import sha256 from 'crypto-js/sha256';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

export interface InviteConfig {
  isInviteOnly: boolean;
}

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
        if (methodName === 'sendInvite' || methodName === 'revokeInvite') {
          UserAuth.hasRole('admin');
        }

        return true;
      },
    },
  };

  async createUser(user: UserSignup, token?: string): Promise<void> {
    const logger = new Logger('SignupService: createUser');
    const db = getDbAsSystem();

    const initSignupResponse = await this.initializeSignup(token);
    if (!initSignupResponse.isReady) {
      throw new Error(initSignupResponse.error);
    }

    const invite = token ? await this.getValidInvite(token) : null;
    if (token) {
      await db.delete(tables.Invite, { token });
    }

    const email = invite ? invite.email : user.email;
    if (!email) {
      throw new Error('Email is required when there is no invite');
    }

    const defaultEmailConfigFactory = getDefaultSignupConfirmationEmailConfigFactory();
    const config = defaultEmailConfigFactory.getConfig();
    const emailSender = new EmailSender();

    const userRecord = await db.get(tables.User, { email });
    if (userRecord) {
      logger.error(`User with this email already exists: ${email}`);
      const { text, html } = config.getExistingUserEmailContent();
      await emailSender.sendEmail({
        to: email,
        subject: config.options?.subject || 'Account already exists',
        text,
        html,
        ...config.options,
      });
      return;
    }

    await db.insert(tables.User, {
      name: user.name,
      email,
      password: sha256(user.password).toString(),
      emailVerified: false,
      roles: '',
      invitedBy: invite ? invite.invitedBy : null,
    });

    const { text, html } = config.getNewUserEmailContent();
    await emailSender.sendEmail({
      to: email,
      subject: config.options?.subject || 'Welcome!',
      text,
      html,
      ...config.options,
    });
    logger.info(`Created user: ${email}`);
  }

  async sendInvite(email: string): Promise<SendInviteResponse> {
    const logger = new Logger('SignupService: sendInvite');
    try {
      const db = getDbAsSystem();
      const userRecord = await db.get(tables.User, { email });
      if (userRecord) {
        return { sent: false, error: 'User already exists with that email.' };
      }

      const token = lib.WordArray.random(32).toString();
      const tokenExpiresAt = moment().add(7, 'days');
      let invite = await db.get(tables.Invite, { email });
      if (invite) {
        invite = {
          ...invite,
          token,
          tokenExpiresAt,
        };
        await db.update(tables.Invite, invite);
      } else {
        const userId = new UserRepo().getUser().id;
        invite = await db.insert(tables.Invite, { email, token, tokenExpiresAt, invitedBy: userId });
      }

      const emailSender = new EmailSender();
      const defaultConfigFactory = getDefaultInviteEmailConfigFactory();
      if (!defaultConfigFactory) {
        throw new Error(
          `Unable to find a @proteinjs/email-server/DefaultInviteEmailConfigFactory implementation when sending invite.`
        );
      }
      const config = defaultConfigFactory.getConfig();
      const { text, html } = config.getEmailContent(`${uiRoutes.auth.signup}?token=${token}`);
      await emailSender.sendEmail({
        to: email,
        subject: config.options?.subject || `You're Invited`,
        text,
        html,
        ...config.options,
      });

      return { sent: true };
    } catch (error: any) {
      logger.error('Error: ', error);
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

    const db = getDb();
    await db.delete(tables.Invite, { email });
  }

  /**
   * Initializes signup process, validating invite configuration and token if provided.
   * `DefaultInviteConfigFactory` defaults to invite optional.
   */
  async initializeSignup(inviteToken: string | undefined): Promise<InitializeSignupResponse> {
    try {
      const config = getDefaultInviteConfigFactory().getConfig();
      const { isInviteOnly } = config;
      const invite = inviteToken ? await this.getValidInvite(inviteToken) : undefined;

      if (isInviteOnly) {
        if (!inviteToken) {
          return {
            isReady: false,
            error: 'An invite is required to sign up.',
            isInviteOnly,
          };
        }
        if (!invite) {
          return {
            isReady: false,
            error: 'The provided invite was not found or has expired.',
            isInviteOnly,
          };
        }
      }

      return {
        isReady: true,
        isInviteOnly,
        invite: invite ? invite : undefined,
      };
    } catch (error: any) {
      return {
        isReady: false,
        error: 'Initializing sign up failed.',
      };
    }
  }

  /** Returns a valid invite if it exists and is not expired, returns `null` otherwise. */
  private async getValidInvite(token: string): Promise<Invite | null> {
    const db = getDbAsSystem();
    const invite = await db.get(tables.Invite, { token });

    if (!invite) {
      return null;
    }

    const currentTime = moment();
    if (invite.tokenExpiresAt && moment(invite.tokenExpiresAt).isBefore(currentTime)) {
      return null;
    }

    return invite;
  }
}
