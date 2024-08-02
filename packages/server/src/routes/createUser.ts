import sha256 from 'crypto-js/sha256';
import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { User, tables, routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/util';
import { EmailSender, getDefaultSignupConfirmationEmailConfigFactory } from '@proteinjs/email-server';

export const createUser: Route = {
  path: routes.createUser.path,
  method: routes.createUser.method,
  onRequest: async (request, response): Promise<void> => {
    const logger = new Logger('createUser');
    const user = request.body as User;
    const db = getDbAsSystem();
    const userRecord = await db.get(tables.User, { email: user.email });
    const emailSender = new EmailSender();
    const defaultEmailConfigFactory = getDefaultSignupConfirmationEmailConfigFactory();
    if (!defaultEmailConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/email-server/DefaultPasswordResetEmailConfigFactory implementation when creating user.`
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
      });
      response.send({});
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
    });
    logger.info(`Created user: ${user.email}`);
    response.send({});
  },
};
