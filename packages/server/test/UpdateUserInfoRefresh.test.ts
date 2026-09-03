import { getDbAsSystem } from '@proteinjs/db';
import { tables, UserRepo } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';

const testEnv = new UserServerTestEnvironment();

/**
 * `refresh()` is the read-only half of the persist-and-refresh helper: no write, just the stored
 * row pulled back into the session cache. It exists for changes this session did not make — an
 * avatar set on the phone, a rename from another tab, an admin clearing an avatar — which
 * otherwise stay invisible here until the next sign-in, because the cached user is only ever
 * rewritten by this session's OWN mutations.
 */
describe('UpdateUserInfo.refresh — re-reads the stored row into the session cache', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('picks up a change made outside this session, and returns the row password-less', async () => {
    const user = await testEnv.createUser({ name: 'Two Devices', email: 'refresh@test.local' });
    testEnv.actAs(user);

    // The other device's write: the row moves, this session's cached user does not.
    await getDbAsSystem().update(tables.User, { avatarEmoji: '🦊' }, { id: user.id });
    expect(new UserRepo().getUser().avatarEmoji).toBeFalsy();

    const updated = await new UpdateUserInfo().refresh();

    expect(updated.id).toBe(user.id);
    expect(updated.avatarEmoji).toBe('🦊');
    expect((updated as any).password).toBeUndefined();
    // The point of the call: the cached user carries it now, with no re-login.
    expect(new UserRepo().getUser().avatarEmoji).toBe('🦊');
  });
});
