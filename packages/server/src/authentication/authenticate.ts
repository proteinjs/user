import sha256 from 'crypto-js/sha256';
import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { DefaultAdminCredentials } from './DefaultAdminCredentials';

export function createAuthentication(defaultAdminCredentials?: { username: string; password: string }) {
  if (defaultAdminCredentials) {
    DefaultAdminCredentials.setCredentials(defaultAdminCredentials);
  }

  return authenticate;
}

export async function authenticate(email: string, password: string): Promise<true | string> {
  const logger = new Logger({ name: 'authenticate' });
  const defaultAdminCredentials = DefaultAdminCredentials.getCredentials();
  if (
    defaultAdminCredentials &&
    defaultAdminCredentials.username == email &&
    defaultAdminCredentials.password == password
  ) {
    logger.info({ message: 'Authenitcated default admin user' });
    return true;
  }

  const users = await getDbAsSystem().query(tables.User, {
    email: email.toLowerCase(),
    password: sha256(password).toString(),
  });
  if (users.length < 1) {
    return 'User name or password incorrect';
  }

  return true;
}
