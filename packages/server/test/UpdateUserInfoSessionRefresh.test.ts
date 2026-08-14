import { getDbAsSystem } from '@proteinjs/db';
import { tables, UserRepo } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';

const testEnv = new UserServerTestEnvironment();

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
});
