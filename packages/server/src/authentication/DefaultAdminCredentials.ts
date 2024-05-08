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
}
