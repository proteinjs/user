import moment from 'moment';
import { User } from '@proteinjs/user';

/**
 * The built-in default admin: credentials a consumer may hand `createAuthentication`, for an
 * identity that has NO account row. This class is the one place that says what that identity is —
 * the session cache resolves it (`userCache`) and the sign-in door asks about it (`login`) through
 * `identityOf`, by the address alone, so the two can never disagree on who an address signs in as.
 */
export class DefaultAdminCredentials {
  private static CREDENTIALS: { username: string; password: string } | undefined;

  static setCredentials(credentials: { username: string; password: string }) {
    if (DefaultAdminCredentials.CREDENTIALS) {
      return;
    }

    DefaultAdminCredentials.CREDENTIALS = credentials;
  }

  static getCredentials() {
    return DefaultAdminCredentials.CREDENTIALS;
  }

  /**
   * The identity a session bound to `email` resolves as when the address is the default admin's: a
   * built-in identity holding `admin`. Nothing an account row carries exists for it — no status,
   * no passkey. Undefined for every other address, and where the consumer declared no default admin.
   */
  static identityOf(email: string): User | undefined {
    const credentials = DefaultAdminCredentials.CREDENTIALS;
    if (!credentials || email != credentials.username) {
      return undefined;
    }

    return {
      name: 'Admin',
      email: credentials.username,
      password: credentials.password,
      emailVerified: true,
      roles: ['admin'],
      created: moment(),
      updated: moment(),
      id: 'admin',
    };
  }
}
