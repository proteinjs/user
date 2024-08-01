import { getDb } from '@proteinjs/db';
import {
  Invite as InviteRecord,
  InviteErrorCode,
  InviteService,
  SendInviteResponse,
  tables,
  UserAuth,
} from '@proteinjs/user';
import moment from 'moment';
import { lib } from 'crypto-js';
import { Logger } from '@proteinjs/util';
import { EmailSender, getDefaultInviteEmailConfigFactory as getDefaultConfigFactory } from '@proteinjs/email-server';

export class Invite implements InviteService {
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

  async sendInvite(email: string, invitePath: string): Promise<SendInviteResponse> {
    const logger = new Logger('InviteService: sendInvite');
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
      const defaultConfigFactory = getDefaultConfigFactory();
      if (!defaultConfigFactory) {
        throw new Error(
          `Unable to find a @proteinjs/email-server/DefaultInviteEmailConfigFactory implementation when initiating password reset.`
        );
      }
      const config = defaultConfigFactory.getConfig();
      const { text, html } = config.getEmailContent(`${invitePath}?token=${token}`);

      // Send email containing a reset link
      await emailSender.sendEmail({
        to: email,
        subject: config.options?.subject || `You're Invited`,
        text,
        html,
      });

      return {
        sent: true,
        invite,
      };
    } catch (error: any) {
      logger.error('Error: ', error);
      return {
        sent: false,
        errorCode: InviteErrorCode.UNEXPECTED_ERROR,
      };
    }
  }

  async revokeInvite(email: string): Promise<void> {
    throw new Error('Method not implemented.');
  }

  async isTokenValid(token: string): Promise<boolean> {
    const logger = new Logger('InviteService: isTokenValid');
    // veronica todo: should i be wrapping all of these in try/catch?
    try {
      const db = getDb();
      const invite = await db.get(tables.Invite, { token });
      if (invite) {
        return true;
      }
      return false;
    } catch (error: any) {
      // return 500? how to even do that?
      logger.error('Error: ', error);
      return false;
    }
  }
}
