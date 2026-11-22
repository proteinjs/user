import { getDbAsSystem } from '@proteinjs/db';
import { User, tables } from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { DefaultAdminCredentials } from './DefaultAdminCredentials';
import { PasswordHasher } from './PasswordHasher';

export function createAuthentication(defaultAdminCredentials?: { username: string; password: string }) {
  if (defaultAdminCredentials) {
    DefaultAdminCredentials.setCredentials(defaultAdminCredentials);
  }

  return authenticate;
}

/**
 * The sentence a log-in reads when the email and the password are not an account's: from the judgment
 * (`judgeCredentials`), and from the log-in route when the account no longer holds the password once
 * the session is made (`PasswordSession`).
 */
export const INCORRECT_CREDENTIALS = 'User name or password incorrect';

/**
 * What a judgment of an email and a password answers. With a `refusal`, the sentence the person reads.
 * Without one the pair was accepted, and `stored` is the password as the account's row holds it once the
 * judgment is made (after its re-hash, when it made one): what a session made on this judgment is held
 * to (`PasswordSession`). The default admin has no row, and so no `stored`.
 */
export type CredentialsJudgment = { refusal: string; stored?: undefined } | { refusal?: undefined; stored?: string };

/** The server's credential check (`ServerConfig.authenticate`): true, or the sentence the person reads. */
export async function authenticate(email: string, password: string): Promise<true | string> {
  return (await judgeCredentials(email, password)).refusal ?? true;
}

/** The judgment `authenticate` answers the verdict of, with what a session made on it is held to. */
export async function judgeCredentials(email: string, password: string): Promise<CredentialsJudgment> {
  const logger = new Logger({ name: 'authenticate' });
  const defaultAdminCredentials = DefaultAdminCredentials.getCredentials();
  if (
    defaultAdminCredentials &&
    defaultAdminCredentials.username == email &&
    defaultAdminCredentials.password == password
  ) {
    logger.info({ message: 'Authenitcated default admin user' });
    return {};
  }

  const { user, matches } = await checkPassword(email, password);
  if (!user || !matches) {
    return { refusal: INCORRECT_CREDENTIALS };
  }
  const db = getDbAsSystem();
  const hasher = new PasswordHasher();

  // Verify-then-rehash: the just-proven password re-hashes a legacy sha256 row into the
  // current format in place — the only moment the plaintext is available to migrate with.
  // Machine rows (isLoadedFromSource) never rehash: sha256 IS their format (see PasswordHasher).
  const mode = user.isLoadedFromSource === true ? 'machine' : 'human';
  let stored = user.password;
  if (hasher.needsRehash(user.password, mode)) {
    stored = await hasher.hash(password);
    await db.update(tables.User, { id: user.id, password: stored });
  }

  // Deactivated accounts are refused a new session even with correct credentials; the session
  // side of the same gate lives in userCache (deactivated sessions resolve as guest).
  if (user.status === 'deactivated') {
    // Pending-deletion accounts (deactivated by the account-deletion flow, not the staff toggle)
    // may authenticate: logging back in IS the cancel signal — the login route runs the cancel
    // hook before request.login and decides. No purgeAfter check here: the cancel's CAS claim is
    // the arbiter, so a user beating the purge walker to a just-expired window wins honestly.
    if (user.deleteRequestedAt != null) {
      return { stored };
    }

    logger.warn({
      message: 'Refused login for deactivated account',
      obj: { account: new RequestDigests().account(email) },
    });
    return { refusal: 'This account has been deactivated' };
  }

  return { stored };
}

/**
 * Looks the account up and verifies the password — the cost every refusal pays, whether or not
 * the address has an account: with none, the password is verified against a stand-in of the
 * same cost (`PasswordHasher.verifyAgainstNothing`), so a refusal's timing says nothing about
 * the address; a human row still in the legacy sha256 format (verified in microseconds) pays the
 * stand-in too, so a refusal's timing says nothing about whether the account has signed in since
 * the format changed either. The login door also runs it on a throttled try and discards the
 * verdict, so a throttled answer takes as long as a refused password. No side effects (no
 * rehash, no log).
 */
export async function checkPassword(email: string, password: string): Promise<{ user?: User; matches: boolean }> {
  // Fetch by EMAIL ONLY and compare in code — never query by password hash. Query-by-hash
  // forced every stored credential into one deterministic queryable value (unsalted sha256);
  // in-code comparison is what lets the stored format be salted and per-user.
  const user = await getDbAsSystem().get(tables.User, { email: email.toLowerCase() });
  const hasher = new PasswordHasher();
  if (!user) {
    return { matches: await hasher.verifyAgainstNothing(password) };
  }
  const matches = await hasher.verify(user.password, password);
  if (hasher.needsRehash(user.password, user.isLoadedFromSource === true ? 'machine' : 'human')) {
    await hasher.verifyAgainstNothing(password);
  }
  return { user, matches };
}
