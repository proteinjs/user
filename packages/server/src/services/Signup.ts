import { getDb, getDbAsSystem } from '@proteinjs/db';
import {
  SendInviteResponse,
  tables,
  UserAuth,
  uiRoutes,
  SignupService,
  User,
  SignupType,
  InitializeSignupResponse,
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

export interface SignupConfig {
  type: SignupType;
}

export interface DefaultSignupConfigFactory extends Loadable {
  getConfig(): SignupConfig;
}

export const getDefaultSignupConfigFactory = () =>
  SourceRepository.get().object<DefaultSignupConfigFactory>('@proteinjs/user-server/DefaultSignupConfigFactory');

export class Signup implements SignupService {
  public serviceMetadata = {
    // veronica todo: do we have throttling in place already for our services?
    auth: {
      canAccess: (methodName: string, args: any[]) => {
        if (methodName === 'isTokenValid') {
          return true;
        }

        return UserAuth.hasRole('admin');
      },
    },
  };

  async createUser(user: Pick<User, 'name' | 'email' | 'password'>, token?: string): Promise<void> {
    const logger = new Logger('SignupService: createUser');
    const db = getDbAsSystem();
    const userRecord = await db.get(tables.User, { email: user.email });

    const emailSender = new EmailSender();
    const defaultEmailConfigFactory = getDefaultSignupConfirmationEmailConfigFactory();
    if (!defaultEmailConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/email-server/DefaultSignupConfirmationEmailConfigFactory implementation when creating user.`
      );
    }

    const config = defaultEmailConfigFactory.getConfig();
    if (userRecord) {
      logger.error(`User with this email already exists: ${user.email}`);
      const { text, html } = config.getExistingUserEmailContent();
      await emailSender.sendEmail({
        to: user.email,
        subject: config.options?.subject || 'Login to your account',
        text,
        html,
        ...config.options,
      });
      return;
    }

    await db.insert(tables.User, {
      name: user.name,
      email: user.email,
      password: sha256(user.password).toString(),
      emailVerified: false,
      roles: '',
    });

    const { text, html } = config.getNewUserEmailContent();
    await emailSender.sendEmail({
      to: user.email,
      subject: config.options?.subject || 'Welcome!',
      text,
      html,
      ...config.options,
    });
    logger.info(`Created user: ${user.email}`);
  }

  async sendInvite(email: string): Promise<SendInviteResponse> {
    const logger = new Logger('SignupService: sendInvite');
    try {
      const token = lib.WordArray.random(32).toString();
      const tokenExpiresAt = moment().add(7, 'days');
      const db = getDb();
      let invite = await db.get(tables.Invite, { email });
      if (invite) {
        invite = {
          ...invite,
          token,
          tokenExpiresAt,
          status: 'pending',
        };
        await db.update(tables.Invite, invite);
      } else {
        invite = await db.insert(tables.Invite, { email, status: 'pending', token, tokenExpiresAt });
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

      return {
        sent: true,
        invite,
      };
    } catch (error: any) {
      logger.error('Error: ', error);
      return {
        sent: false,
        error: 'Error sending invite',
      };
    }
  }

  async revokeInvite(email: string): Promise<void> {
    throw new Error('Method not implemented.');
  }

  async initializeSignup(inviteToken: string): Promise<InitializeSignupResponse> {
    const logger = new Logger('SignupService: initializeSignup');
    try {
      const defaultSignupConfigFactory = getDefaultSignupConfigFactory();
      if (!defaultSignupConfigFactory) {
        throw new Error(
          `Unable to find a @proteinjs/user-server/DefaultSignupConfigFactory implementation when validating signup token.`
        );
      }

      const config = defaultSignupConfigFactory.getConfig();

      switch (config.type) {
        case 'inviteOnly':
          if (!inviteToken) {
            return {
              signupType: config.type,
              isReady: false,
              error: 'An invite is required to sign up.',
            };
          }
          if (!(await this.isInviteTokenValid(inviteToken))) {
            return {
              signupType: config.type,
              isReady: false,
              error: 'The provided invite token is invalid or has expired.',
            };
          }
          return {
            signupType: config.type,
            isReady: true,
          };

        case 'inviteOptional':
          if (inviteToken) {
            if (await this.isInviteTokenValid(inviteToken)) {
              return {
                signupType: config.type,
                isReady: true,
              };
            }
            return {
              signupType: config.type,
              isReady: true,
              error: 'The provided invite token is invalid or has expired. You may proceed with regular sign up.',
            };
          }
          return {
            signupType: config.type,
            isReady: true,
          };

        case 'signupOnly':
          return {
            signupType: config.type,
            isReady: true,
            error: inviteToken ? 'Invite token ignored for open signup.' : undefined,
          };
      }
    } catch (error: any) {
      // return 500? how to even do that?
      logger.error('Error: ', error);
      return {
        isReady: false,
        error: 'Initializing sign up failed.',
      };
    }
  }

  private async isInviteTokenValid(token: string): Promise<boolean> {
    const db = getDb();
    const invite = await db.get(tables.Invite, { token });
    if (invite) {
      return true;
    }
    return false;
  }
}
