import moment from 'moment';
import { User } from '@proteinjs/user';

/**
 * The built-in default admin: credentials a consumer may hand `createAuthentication`, for an
 * identity that has NO account row. This class is the ONE owner of "is this address the default
 * admin's": the declared credentials are read here and nowhere else, and the address is compared
 * in one method (`is`) under one rule — without regard to case, as an account's address is stored
 * and a session's is bound. Everyone who needs the answer asks here: the password step
 * (`authenticate`, through `opens`), the sign-in door and the per-request session cache (`login`
 * and `userCache`, through `identityOf`) and account deletion (`AccountDeletion`, through `is`) —
 * so no two of them can disagree on who an address signs in as, however it was typed or declared.
 */
export class DefaultAdminCredentials {
  private static CREDENTIALS: { username: string; password: string } | undefined;

  static setCredentials(credentials: { username: string; password: string }) {
    if (DefaultAdminCredentials.CREDENTIALS) {
      return;
    }

    DefaultAdminCredentials.CREDENTIALS = credentials;
  }

  /** Whether `email` and `password` are the declared credentials: the password step's question. */
  static opens(email: string, password: string): boolean {
    return DefaultAdminCredentials.is(email) && DefaultAdminCredentials.CREDENTIALS?.password === password;
  }

  /**
   * The identity a session bound to `email` resolves as when the address is the default admin's: a
   * built-in identity holding `admin`, under the declared address in the form an account's is
   * stored (lowercased). Nothing an account row carries exists for it — no status, no passkey.
   * Undefined for every other address, and where the consumer declared no default admin.
   */
  static identityOf(email: string): User | undefined {
    const credentials = DefaultAdminCredentials.CREDENTIALS;
    if (!credentials || !DefaultAdminCredentials.is(email)) {
      return undefined;
    }

    return {
      name: 'Admin',
      email: credentials.username.toLowerCase(),
      password: credentials.password,
      emailVerified: true,
      roles: ['admin'],
      created: moment(),
      updated: moment(),
      id: 'admin',
    };
  }

  /**
   * THE comparison: whether `email` is the declared default admin's address. Addresses compare
   * without regard to case; a value that is not text, and every address where no default admin is
   * declared, is not it.
   */
  static is(email: unknown): boolean {
    const credentials = DefaultAdminCredentials.CREDENTIALS;
    return (
      credentials !== undefined &&
      typeof email === 'string' &&
      email.toLowerCase() === credentials.username.toLowerCase()
    );
  }
}
