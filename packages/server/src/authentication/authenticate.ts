import sha256 from 'crypto-js/sha256';
import { getSystemDb } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { DefaultAdminCredentials } from './DefaultAdminCredentials';

export function createAuthentication(defaultAdminCredentials?: { username: string; password: string }) {
  if (defaultAdminCredentials) {
    DefaultAdminCredentials.setCredentials(defaultAdminCredentials);
  }

  return authenticate;
}

export async function authenticate(email: string, password: string): Promise<true | string> {
  const defaultAdminCredentials = DefaultAdminCredentials.getCredentials();
  if (
    defaultAdminCredentials &&
    defaultAdminCredentials.username == email &&
    defaultAdminCredentials.password == password
  ) {
    console.info('Authenitcated default admin user');
    return true;
  }

  const users = await getSystemDb().query(tables.User, {
    email,
    password: sha256(password).toString(),
  });
  if (users.length < 1) {
    return 'User name or password incorrect';
  }

  return true;
}
