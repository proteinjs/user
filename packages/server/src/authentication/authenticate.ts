import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { DefaultAdminCredentials } from './DefaultAdminCredentials';
import { PasswordHasher } from './PasswordHasher';

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

  // Fetch by EMAIL ONLY and compare in code — never query by password hash. Query-by-hash
  // forced every stored credential into one deterministic queryable value (unsalted sha256);
  // in-code comparison is what lets the stored format be salted and per-user.
  const db = getDbAsSystem();
  const user = await db.get(tables.User, { email: email.toLowerCase() });
  const hasher = new PasswordHasher();
  if (!user || !(await hasher.verify(user.password, password))) {
    return 'User name or password incorrect';
  }

  // Verify-then-rehash: the just-proven password re-hashes a legacy sha256 row into the
  // current format in place — the only moment the plaintext is available to migrate with.
  // Machine rows (isLoadedFromSource) never rehash: sha256 IS their format (see PasswordHasher).
  const mode = user.isLoadedFromSource === true ? 'machine' : 'human';
  if (hasher.needsRehash(user.password, mode)) {
    await db.update(tables.User, { id: user.id, password: await hasher.hash(password) });
  }

  // Deactivated accounts are refused a new session even with correct credentials; the session
  // side of the same gate lives in userCache (deactivated sessions resolve as guest).
  if (user.status === 'deactivated') {
    // Pending-deletion accounts (deactivated by the account-deletion flow, not the staff toggle)
    // may authenticate: logging back in IS the cancel signal — the login route runs the cancel
    // hook before request.login and decides. No purgeAfter check here: the cancel's CAS claim is
    // the arbiter, so a user beating the purge walker to a just-expired window wins honestly.
    if (user.deleteRequestedAt != null) {
      return true;
    }

    logger.warn({ message: 'Refused login for deactivated account', obj: { email: email.toLowerCase() } });
    return 'This account has been deactivated';
  }

  return true;
}
