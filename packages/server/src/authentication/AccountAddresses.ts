import { getDbAsSystem } from '@proteinjs/db';
import { tables } from '@proteinjs/user';
import { DefaultAdminCredentials } from './DefaultAdminCredentials';

/**
 * The ONE owner of "does an account already hold this address" — asked before every write that
 * would give an account row an address: account creation (`Signup.createAccount`, the door of
 * every sign-up, by invite or without, and of the development door's test accounts) and an address
 * change (`UserAccountAdmin.setEmail`) — and before an invite is mailed to one (`Signup.sendInvite`,
 * `Signup.resendInvite`): an address in use is not invited.
 *
 * An address is held by the account row that carries it — and by the built-in default admin
 * (`DefaultAdminCredentials`), which signs in under its declared address with no row at all. A
 * session bound to that address resolves as the built-in admin whoever opened it (`userCache`), so
 * no row may come to hold it, and to every door it is simply an address in use. (A row that holds
 * it all the same opens nothing: the sign-in judges that address against the declared credentials
 * alone — `authenticate`.)
 */
export class AccountAddresses {
  /** Whether an account holds `email`, compared as an account's address is stored: lowercased. */
  async held(email: string): Promise<boolean> {
    const address = email.toLowerCase();
    return DefaultAdminCredentials.is(address) || Boolean(await getDbAsSystem().get(tables.User, { email: address }));
  }
}
