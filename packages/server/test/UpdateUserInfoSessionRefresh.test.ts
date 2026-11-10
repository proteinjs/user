/**
 * The password-updated mail is stubbed at the module boundary (the SignupRoute.test.ts pattern):
 * `updatePassword` mails the account before it writes, and the suite proves outcomes, not mail.
 */
const sendEmail = jest.fn();

jest.mock('@proteinjs/email-server', () => ({
  EmailSender: jest.fn().mockImplementation(() => ({ sendEmail })),
  getDefaultPasswordUpdatedEmailConfigFactory: () => ({
    getConfig: () => ({ text: 'changed', html: '<p>changed</p>' }),
  }),
}));

import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { PasswordPolicy, tables, User, UserRepo } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';

const testEnv = new UserServerTestEnvironment();

/** The session row of `owner` under `sessionId`, live for a day. */
const sessionRow = (sessionId: string, owner: User) => ({
  sessionId,
  session: JSON.stringify({ cookie: {}, passport: { user: owner.email } }),
  expires: moment().add(1, 'day').toDate(),
  userEmail: owner.email,
});

/**
 * The rename-staleness wart, red-before-green: UpdateUserInfo.updateName wrote the DB but never
 * refreshed the server session cache (userCache serializes the user into session data), so every
 * read through UserRepo in the same request context — and any long-lived context that keeps its
 * session data, e.g. socket sessions — kept serving the OLD name until re-login. The fix routes
 * every user-info mutation through one helper that persists AND refreshes the session cache.
 */
describe('UpdateUserInfo.updateName — persists AND refreshes the server session cache', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('updates the user row and the session-cached user in the same stroke', async () => {
    const user = await testEnv.createUser({ name: 'Old Name', email: 'rename@test.local' });
    testEnv.actAs(user);

    await new UpdateUserInfo().updateName('New Name');

    // Outcome 1: the row is renamed (held even pre-fix).
    const row = await getDbAsSystem().get(tables.User, { id: user.id });
    expect(row.name).toBe('New Name');

    // Outcome 2 (the wart): the session cache must serve the new name too. RED pre-fix.
    expect(new UserRepo().getUser().name).toBe('New Name');
  });

  /**
   * The signed-in change: the new password is held to the server's rules before anything else
   * (the shared minimum length, then the common-passwords list — the refusal in the policy's own
   * words, which the form shows), and a change that lands ends every OTHER session of the
   * account — the device holding a session opened under the old password signs out; the device
   * that made the change (this request's session, `test-session` in the environment) keeps its.
   */
  describe('updatePassword', () => {
    const withCurrentPassword = async (email: string, currentPassword: string): Promise<User> => {
      const user = await testEnv.createUser({ name: 'Changer', email });
      await getDbAsSystem().update(tables.User, {
        id: user.id,
        password: await new PasswordHasher().hash(currentPassword),
      });
      testEnv.actAs(user);
      return user;
    };

    beforeEach(() => {
      sendEmail.mockClear();
    });

    it(`refuses a password under the minimum, or on the common-passwords list, in the policy's words — nothing written, no mail`, async () => {
      const user = await withCurrentPassword('rules@test.local', 'current-password-1');
      const before = (await getDbAsSystem().get(tables.User, { id: user.id })).password;

      const short = await new UpdateUserInfo().updatePassword(
        'current-password-1',
        'a'.repeat(PasswordPolicy.MIN_LENGTH - 1)
      );
      expect(short).toEqual({ updated: false, error: PasswordPolicy.TOO_SHORT });

      const common = await new UpdateUserInfo().updatePassword('current-password-1', 'Password1');
      expect(common).toEqual({ updated: false, error: PasswordPolicy.TOO_COMMON });

      expect((await getDbAsSystem().get(tables.User, { id: user.id })).password).toBe(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it(`a change ends the account's other sessions and keeps the one that made it — another account's stay`, async () => {
      const user = await withCurrentPassword('sessions@test.local', 'current-password-2');
      const bystander = await testEnv.createUser({ name: 'Bystander', email: 'sessions-bystander@test.local' });
      const db = getDbAsSystem();
      await db.insert(tables.Session, sessionRow('test-session', user)); // this request's own session
      await db.insert(tables.Session, sessionRow('other-phone', user));
      await db.insert(tables.Session, sessionRow('other-laptop', user));
      await db.insert(tables.Session, sessionRow('bystander-phone', bystander));

      const outcome = await new UpdateUserInfo().updatePassword('current-password-2', 'a new long password');

      expect(outcome).toEqual({ updated: true });
      await expect(
        new PasswordHasher().verify((await db.get(tables.User, { id: user.id })).password, 'a new long password')
      ).resolves.toBe(true);
      expect((await db.query(tables.Session, { userEmail: user.email })).map((row) => row.sessionId)).toEqual([
        'test-session',
      ]);
      expect((await db.query(tables.Session, { userEmail: bystander.email })).map((row) => row.sessionId)).toEqual([
        'bystander-phone',
      ]);
    });
  });
});
