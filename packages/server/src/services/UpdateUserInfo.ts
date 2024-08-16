import { getDbAsSystem } from '@proteinjs/db';
import { tables, UserRepo, UpdatePasswordResponse, UpdateUserInfoService } from '@proteinjs/user';
import { EmailSender, getDefaultPasswordUpdatedEmailConfigFactory } from '@proteinjs/email-server';
import sha256 from 'crypto-js/sha256';

export class UpdateUserInfo implements UpdateUserInfoService {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  async updateName(name: string): Promise<void> {
    const db = getDbAsSystem();
    const user = new UserRepo().getUser();
    await db.update(tables.User, { name }, { id: user.id });
  }

  async updatePassword(currentPassword: string, newPassword: string): Promise<UpdatePasswordResponse> {
    const db = getDbAsSystem();
    const userId = new UserRepo().getUser().id;

    // verify current password
    const hashedCurrentPassword = sha256(currentPassword).toString();
    const user = await db.get(tables.User, { id: userId });
    if (hashedCurrentPassword !== user.password) {
      return {
        updated: false,
        error: `Invalid password`,
      };
    }

    try {
      const emailSender = new EmailSender();
      const defaultConfigFactory = getDefaultPasswordUpdatedEmailConfigFactory();
      const config = defaultConfigFactory.getConfig();

      // send email to user that their password changed
      await emailSender.sendEmail({
        to: user.email,
        subject: config.options?.subject || 'Your password has been changed',
        text: config.text,
        html: config.html,
        ...config.options,
      });
    } catch (error: any) {
      return {
        updated: false,
        error: `Email failed to send`,
      };
    }

    // If email is sent successfully,
    // hash and store new password
    try {
      const hashedNewPassword = sha256(newPassword).toString();
      await db.update(
        tables.User,
        {
          password: hashedNewPassword,
        },
        { id: user.id }
      );
    } catch (error: any) {
      return {
        updated: false,
        error: `Password db update failed`,
      };
    }

    return {
      updated: true,
    };
  }
}
