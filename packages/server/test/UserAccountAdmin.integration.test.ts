import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables, User, USER_PERMISSIONS } from '@proteinjs/user';
import { EmailVerificationToken } from '../src/authentication/EmailVerificationToken';
import { UserAccountAdmin } from '../src/services/UserAccountAdmin';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * The UserAccountAdmin service is the ONE write path a client has to another account's plain
 * cells now that the user table has no generic write door: a name, an address, the verified
 * flag — each change with its `user_account_event` audit row in the same transaction, a change
 * to what the row already holds writing nothing. An address change un-verifies the address,
 * clears the pending verification token and ends the account's sessions. Outcomes against the
 * emulator: the rows written, never the calls made.
 *
 * The service door itself (`{ permission: 'users' }`) is resolved by ServiceAuth — covered in
 * @proteinjs/service — so these tests call the implementation directly and pin the metadata.
 */
describe(`UserAccountAdmin — another account's cells, audited`, () => {
  let actor: User;
  const service = () => new UserAccountAdmin();
  const row = async (id: string) => await getDbAsSystem().get(tables.User, { id });
  // The rows as a set: the query carries no order, so the rows are sorted by field, then value.
  const events = async (target: string) =>
    (await getDbAsSystem().query(tables.UserAccountEvent, { target }))
      .map((event) => ({ actor: event.actor, field: event.field, value: event.value ?? null }))
      .sort((a, b) => `${a.field}:${a.value ?? ''}`.localeCompare(`${b.field}:${b.value ?? ''}`));
  const sessionRow = (sessionId: string, owner: User) => ({
    sessionId,
    session: JSON.stringify({ cookie: {}, passport: { user: owner.email } }),
    expires: moment().add(1, 'day').toDate(),
    userEmail: owner.email,
  });

  beforeAll(async () => {
    await testEnv.beforeAll();
    actor = await testEnv.createUser({ name: 'People Desk', email: 'people.desk@test.local', roles: ['people-desk'] });
    testEnv.actAs(actor);
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('rides the users permission', () => {
    expect(service().serviceMetadata).toEqual({ auth: { permission: USER_PERMISSIONS.users } });
  });

  it('setName writes the name and one audit row carrying no value; the same name again writes nothing', async () => {
    const target = await testEnv.createUser({ name: 'Old Name', email: 'rename.target@test.local' });

    await service().setName(target.id, '  New Name ');
    await service().setName(target.id, 'New Name');

    expect((await row(target.id)).name).toBe('New Name');
    expect(await events(target.id)).toEqual([{ actor: actor.id, field: 'name', value: null }]);
    await expect(service().setName(target.id, '   ')).rejects.toThrow(/name/i);
  });

  it(`setEmail lowercases the address, un-verifies it, clears the pending verification token, ends the account's sessions (not another's) and writes one audit row with no value`, async () => {
    const target = await testEnv.createUser({ name: 'Mover', email: 'mover@test.local' });
    const bystander = await testEnv.createUser({ name: 'Bystander', email: 'bystander@test.local' });
    await new EmailVerificationToken().mint(target);
    const db = getDbAsSystem();
    await db.insert(tables.Session, sessionRow('mover-phone', target));
    await db.insert(tables.Session, sessionRow('mover-laptop', target));
    await db.insert(tables.Session, sessionRow('bystander-phone', bystander));

    await service().setEmail(target.id, ' Moved.Address@Test.local ');

    const moved = await row(target.id);
    expect(moved.email).toBe('moved.address@test.local');
    expect(moved.emailVerified).toBe(false);
    expect(moved.emailVerificationToken).toBeNull();
    expect(moved.emailVerificationTokenExpiration).toBeNull();
    expect(await events(target.id)).toEqual([{ actor: actor.id, field: 'email', value: null }]);
    expect(await db.query(tables.Session, { userEmail: 'mover@test.local' })).toEqual([]);
    expect(
      (await db.query(tables.Session, { userEmail: bystander.email })).map((session) => session.sessionId)
    ).toEqual(['bystander-phone']);

    // The same address again: nothing written, no second row.
    await service().setEmail(target.id, 'moved.address@test.local');
    expect(await events(target.id)).toHaveLength(1);
  });

  it('setEmail refuses a malformed address, an address another account holds, and a machine account — nothing written', async () => {
    const target = await testEnv.createUser({ name: 'Holder', email: 'holder@test.local' });
    const other = await testEnv.createUser({ name: 'Other', email: 'other@test.local' });
    const machine = await testEnv.createUser({ name: 'Machine', email: 'machine@test.local' });
    await getDbAsSystem().update(tables.User, { id: machine.id, isLoadedFromSource: true });

    await expect(service().setEmail(target.id, 'not-an-address')).rejects.toThrow(/valid email/i);
    await expect(service().setEmail(target.id, 'Other@test.local')).rejects.toThrow(/another account/i);
    await expect(service().setEmail(machine.id, 'renamed.machine@test.local')).rejects.toThrow(/machine account/i);

    expect((await row(target.id)).email).toBe('holder@test.local');
    expect((await row(other.id)).email).toBe('other@test.local');
    expect((await row(machine.id)).email).toBe('machine@test.local');
    expect(await events(target.id)).toEqual([]);
    expect(await events(machine.id)).toEqual([]);
  });

  it(`setEmailVerified writes the flag with its word as the row's value and clears the pending token; already so writes nothing`, async () => {
    const target = await testEnv.createUser({ name: 'Unverified', email: 'unverified@test.local' });
    await getDbAsSystem().update(tables.User, { id: target.id, emailVerified: false });
    await new EmailVerificationToken().mint(target);

    await service().setEmailVerified(target.id, true);
    await service().setEmailVerified(target.id, true);

    const verified = await row(target.id);
    expect(verified.emailVerified).toBe(true);
    expect(verified.emailVerificationToken).toBeNull();
    expect(await events(target.id)).toEqual([{ actor: actor.id, field: 'emailVerified', value: 'true' }]);

    await service().setEmailVerified(target.id, false);
    expect((await row(target.id)).emailVerified).toBe(false);
    expect(await events(target.id)).toEqual([
      { actor: actor.id, field: 'emailVerified', value: 'false' },
      { actor: actor.id, field: 'emailVerified', value: 'true' },
    ]);
  });

  it('a missing account is refused in words', async () => {
    await expect(service().setName('no-such-user', 'Nobody')).rejects.toThrow('No user found for id: no-such-user');
  });
});
