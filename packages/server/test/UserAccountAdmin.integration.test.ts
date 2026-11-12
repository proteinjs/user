import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { RoleCatalogEntry, tables, User, UserRepo, USER_PERMISSIONS } from '@proteinjs/user';
import { EmailVerificationToken } from '../src/authentication/EmailVerificationToken';
import { UserAccountAdmin } from '../src/services/UserAccountAdmin';
import { LogCapture } from './LogCapture';
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
    const objectCache = (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache;
    // The caller's own roles resolve through UserAuth — the same session-backed repo the services use.
    objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
    // Beside the built-in break-glass admin, one consumer role the catalog marks admin-grant-only
    // (the compliance-grant shape), one operator role it marks administrative (the roles desk's) and
    // the people desk's ordinary one.
    objectCache['@proteinjs/user/RoleCatalogEntry'] = [
      { role: 'data-access', description: 'Compliance decrypt grant', adminGrantOnly: true } as RoleCatalogEntry,
      { role: 'roles-desk', description: 'Grant and revoke roles', administrative: true } as RoleCatalogEntry,
      { role: 'people-desk', description: 'Manage user records' } as RoleCatalogEntry,
    ];
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

  /**
   * Whoever holds an account's address holds the account — the reset link is mailed there. So the
   * address of an account that holds an administrative role (the catalog's break-glass,
   * admin-grant-only or administrative mark — held anywhere in the account's list) is an admin's
   * to change: a `users` holder is refused in words, nothing is written and its sessions stand, and
   * the refusal is kept in a log line naming the actor and the target, never an address. A role the
   * catalog does not know (a retired one) marks nothing.
   */
  it(`setEmail on an account that holds an administrative role: a users holder is refused and nothing is written; an admin changes it; a users holder still changes an ordinary account's`, async () => {
    const breakGlass = await testEnv.createUser({
      name: 'Break Glass',
      email: 'break.glass@test.local',
      roles: ['admin'],
    });
    const compliance = await testEnv.createUser({
      name: 'Compliance',
      email: 'compliance@test.local',
      roles: ['data-access'],
    });
    // An ordinary role first, the administrative one after: the list is read whole.
    const rolesDesk = await testEnv.createUser({
      name: 'Roles Desk',
      email: 'roles.desk@test.local',
      roles: ['people-desk', 'roles-desk'],
    });
    const ordinary = await testEnv.createUser({
      name: 'Ordinary',
      email: 'ordinary@test.local',
      roles: ['people-desk', 'retired-role'],
    });
    const db = getDbAsSystem();
    await db.insert(tables.Session, sessionRow('break-glass-phone', breakGlass));

    const log = await LogCapture.during(async () => {
      await expect(service().setEmail(breakGlass.id, 'taken.over@test.local')).rejects.toThrow(/only an admin/i);
      await expect(service().setEmail(compliance.id, 'taken.over@test.local')).rejects.toThrow(/only an admin/i);
      await expect(service().setEmail(rolesDesk.id, 'taken.over@test.local')).rejects.toThrow(/only an admin/i);
    });

    expect((await row(breakGlass.id)).email).toBe('break.glass@test.local');
    expect((await row(breakGlass.id)).emailVerified).toBe(true);
    expect((await row(compliance.id)).email).toBe('compliance@test.local');
    expect((await row(rolesDesk.id)).email).toBe('roles.desk@test.local');
    expect(await events(breakGlass.id)).toEqual([]);
    expect(await events(compliance.id)).toEqual([]);
    expect(await events(rolesDesk.id)).toEqual([]);
    expect(
      (await db.query(tables.Session, { userEmail: breakGlass.email })).map((session) => session.sessionId)
    ).toEqual(['break-glass-phone']);
    const refusals = log.linesContaining('Refused an address change');
    expect(refusals.lines).toHaveLength(3);
    expect(refusals.text).toContain(actor.id);
    expect(refusals.text).toContain(breakGlass.id);
    expect(refusals.text).toContain(compliance.id);
    expect(refusals.text).toContain(rolesDesk.id);
    expect(refusals.addresses).toEqual([]);

    // An ordinary account's address stays the users door's.
    await service().setEmail(ordinary.id, 'ordinary.moved@test.local');
    expect((await row(ordinary.id)).email).toBe('ordinary.moved@test.local');

    // An admin changes the administrative account's address, audited as any change.
    const admin = await testEnv.createUser({ name: 'An Admin', email: 'an.admin@test.local', roles: ['admin'] });
    testEnv.actAs(admin);
    try {
      await service().setEmail(compliance.id, 'compliance.moved@test.local');
    } finally {
      testEnv.actAs(actor);
    }
    expect((await row(compliance.id)).email).toBe('compliance.moved@test.local');
    expect(await events(compliance.id)).toEqual([{ actor: admin.id, field: 'email', value: null }]);
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
