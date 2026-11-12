import moment from 'moment';
import { Db, getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { Session } from '@proteinjs/server-api';
// Deep import (test-only): ServiceAuth is the real RPC door but is not index-exported by
// @proteinjs/service — the passkey services' door case runs the actual gate.
import { ServiceAuth } from '@proteinjs/service/dist/src/ServiceAuth';
import {
  PasskeyConfirmation,
  PasskeyConfirmationPurpose,
  PermissionRolesMapping,
  RoleCatalogEntry,
  guestUser,
  tables,
  User,
  UserAuth,
  UserRepo,
  USER_PERMISSIONS,
} from '@proteinjs/user';
import { AccountSessions } from '../src/authentication/AccountSessions';
import { EmailVerificationToken } from '../src/authentication/EmailVerificationToken';
import { PasskeyAdmin } from '../src/services/PasskeyAdmin';
import { Passkeys } from '../src/services/Passkeys';
import { UserAccountAdmin } from '../src/services/UserAccountAdmin';
import { LogCapture } from './LogCapture';
import { SoftwareAuthenticator } from './SoftwareAuthenticator';
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
 *
 * And the passkey services (the last describe): a person's own passkeys and an admin's reset of
 * another person's — the acts on the same accounts' sign-in, audited in the same table.
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

  /**
   * The passkey services — a person's own passkeys (`Passkeys`) and an admin's reset of another
   * person's (`PasskeyAdmin`) — with a relying party declared and real ceremonies: a software
   * authenticator's registrations and assertions, verified by the real library. The account is
   * the session's (the suite acts as one and rides the environment's session, `test-session`);
   * an act on the passkeys asks for a fresh assertion made for exactly that act in exactly that
   * session; each act is one transaction with its audit row.
   */
  describe('the passkey services, with a relying party declared', () => {
    const RELYING_PARTY = { id: 'example.test', origin: 'https://app.example.test', name: 'Example' };
    const RELYING_PARTY_KEY = '@proteinjs/user-server/PasskeyRelyingParty';
    const ORIGIN = { origin: RELYING_PARTY.origin };
    const objectCache = () =>
      (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache;
    const passkeys = () => new Passkeys();
    const passkeyRows = async (user: User) =>
      (await getDbAsSystem().query(tables.UserPasskey, { scope: user.id })).sort(
        (a, b) => a.created.valueOf() - b.created.valueOf()
      );
    const passkeyEvents = async (target: string) =>
      (await events(target)).filter((event) => event.field === 'passkeys');
    const sessionIdsOf = async (user: User) =>
      (await getDbAsSystem().query(tables.Session, { userEmail: user.email }))
        .map((session) => session.sessionId)
        .sort();

    /** The session the next calls ride: the id a challenge is bound to and an act keeps. */
    const ride = (sessionId: string) => {
      Session.getData().sessionId = sessionId;
    };

    /** Add `authenticator` as the first passkey of the account the suite acts as: no confirmation is owed. */
    const addFirst = async (authenticator = new SoftwareAuthenticator()) => {
      const step = await passkeys().beginAdd();
      await passkeys().finishAdd(step.token, authenticator.register(step.options, ORIGIN));
      return authenticator;
    };

    /** A confirmation of `purpose` by `authenticator`, begun and answered in the session the suite rides. */
    const confirm = async (authenticator: SoftwareAuthenticator, purpose: PasskeyConfirmationPurpose) => {
      const step = await passkeys().beginConfirmation(purpose);
      return { token: step.token, assertion: authenticator.assert(step.options, ORIGIN) };
    };

    /** Add `authenticator` as one more passkey of the account the suite acts as, confirmed by `holder`. */
    const addAnother = async (holder: SoftwareAuthenticator, authenticator = new SoftwareAuthenticator()) => {
      const step = await passkeys().beginAdd(await confirm(holder, { act: 'add' }));
      await passkeys().finishAdd(step.token, authenticator.register(step.options, ORIGIN));
      return authenticator;
    };

    const person = async (name: string, roles: string[]) => {
      const user = await testEnv.createUser({ name, email: `${name}@test.local`, roles });
      testEnv.actAs(user);
      return user;
    };

    beforeAll(() => {
      objectCache()[RELYING_PARTY_KEY] = [{ getRelyingParty: () => RELYING_PARTY }];
    });

    afterAll(() => {
      objectCache()[RELYING_PARTY_KEY] = [];
      ride('test-session');
      testEnv.actAs(actor);
    });

    beforeEach(() => {
      ride('test-session');
    });

    it('the doors, at the real gate: a person’s own passkeys admit any signed-in account and no guest; the reset admits the admin role alone — a holder of the users permission is refused', async () => {
      const mayList = () => ServiceAuth.canRunService(passkeys(), { name: 'list' } as any, []);
      const mayReset = () => ServiceAuth.canRunService(new PasskeyAdmin(), { name: 'reset' } as any, []);
      const mayEditAccounts = () => ServiceAuth.canRunService(service(), { name: 'setName' } as any, []);
      // The people desk holds the `users` permission, as a consumer's mapping gives it.
      const mapping = UserAuth as unknown as { permissionRolesMapping?: PermissionRolesMapping };
      mapping.permissionRolesMapping = {
        getRoles: (permission: string) => (permission === USER_PERMISSIONS.users ? ['people-desk'] : undefined),
      };
      try {
        testEnv.actAs(guestUser as unknown as User);
        expect(mayList()).toBe(false);
        expect(mayReset()).toBe(false);

        testEnv.actAs(actor);
        expect(mayEditAccounts()).toBe(true);
        expect(mayList()).toBe(true);
        expect(mayReset()).toBe(false);

        await person('passkey.door.admin', ['admin']);
        expect(mayList()).toBe(true);
        expect(mayReset()).toBe(true);
      } finally {
        mapping.permissionRolesMapping = undefined;
      }
    });

    it('list returns the caller’s passkeys with no key, and required as the gate reads it; never another account’s rows', async () => {
      await person('passkey.list.other', ['admin']);
      const others = await addFirst();
      const owner = await person('passkey.list.owner', ['roles-desk']);
      const own = await addFirst();

      const listed = await passkeys().list();

      const [row] = await passkeyRows(owner);
      expect(listed.required).toBe(true);
      expect(listed.passkeys.map((passkey) => passkey.id)).toEqual([row.id]);
      expect(Object.keys(listed.passkeys[0]).sort()).toEqual(['backedUp', 'created', 'id', 'lastUsedAt', 'name']);
      const sent = JSON.stringify(listed);
      expect(sent).not.toContain(own.credentialId);
      expect(sent).not.toContain(row.publicKey);
      expect(sent).not.toContain(others.credentialId);

      // Required is the gate's answer: an account that holds no administrative role is not, and
      // where no relying party is declared nobody is — the passkeys an account has are still its to see.
      await person('passkey.list.ordinary', ['people-desk']);
      expect(await passkeys().list()).toEqual({ required: false, passkeys: [] });
      testEnv.actAs(owner);
      objectCache()[RELYING_PARTY_KEY] = [];
      try {
        const undeclared = await passkeys().list();
        expect(undeclared.required).toBe(false);
        expect(undeclared.passkeys.map((passkey) => passkey.id)).toEqual([row.id]);
      } finally {
        objectCache()[RELYING_PARTY_KEY] = [{ getRelyingParty: () => RELYING_PARTY }];
      }
    });

    it('adding a second passkey is refused without a confirmation, and with one made in another session; with one from this session it stores the passkey and writes one audit row', async () => {
      const owner = await person('passkey.add.owner', ['admin']);
      const first = await addFirst();
      expect(await passkeyEvents(owner.id)).toEqual([{ actor: owner.id, field: 'passkeys', value: 'added' }]);

      await expect(passkeys().beginAdd()).rejects.toThrow();
      ride('another-session');
      const elsewhere = await confirm(first, { act: 'add' });
      ride('test-session');
      await expect(passkeys().beginAdd(elsewhere)).rejects.toThrow();
      expect(await passkeyRows(owner)).toHaveLength(1);

      const confirmation = await confirm(first, { act: 'add' });
      const step = await passkeys().beginAdd(confirmation);
      const second = new SoftwareAuthenticator();
      // The add's own step is bound to its session too, and is good once.
      ride('another-session');
      await expect(passkeys().finishAdd(step.token, second.register(step.options, ORIGIN))).rejects.toThrow();
      ride('test-session');
      const again = await passkeys().beginAdd(await confirm(first, { act: 'add' }));
      const added = await passkeys().finishAdd(again.token, second.register(again.options, ORIGIN));
      await expect(
        passkeys().finishAdd(again.token, new SoftwareAuthenticator().register(again.options, ORIGIN))
      ).rejects.toThrow();
      // A confirmation confirms once.
      await expect(passkeys().beginAdd(confirmation)).rejects.toThrow();

      const rows = await passkeyRows(owner);
      expect(rows.map((row) => row.credentialId)).toEqual([first.credentialId, second.credentialId]);
      expect(rows.map((row) => row.name)).toEqual(['Passkey', 'Passkey 2']);
      expect(added.id).toBe(rows[1].id);
      expect(await passkeyEvents(owner.id)).toEqual([
        { actor: owner.id, field: 'passkeys', value: 'added' },
        { actor: owner.id, field: 'passkeys', value: 'added' },
      ]);

      // Adding is for an account that must use a passkey: one that holds no administrative role is refused.
      const ordinary = await person('passkey.add.ordinary', ['people-desk']);
      await expect(passkeys().beginAdd()).rejects.toThrow();
      expect(await passkeyRows(ordinary)).toEqual([]);
    });

    it('an add begun before the account had a passkey adds nothing once it has one', async () => {
      const owner = await person('passkey.add.race', ['admin']);
      const early = await passkeys().beginAdd();
      const first = await addFirst();

      await expect(
        passkeys().finishAdd(early.token, new SoftwareAuthenticator().register(early.options, ORIGIN))
      ).rejects.toThrow();

      expect((await passkeyRows(owner)).map((row) => row.credentialId)).toEqual([first.credentialId]);
      expect(await passkeyEvents(owner.id)).toHaveLength(1);
    });

    it('remove refuses the last passkey of an account that must use one; refuses without a confirmation; with one it deletes the row, ends the account’s other sessions and keeps this one, and writes one audit row', async () => {
      const bystander = await testEnv.createUser({ name: 'Bystander', email: 'passkey.remove.bystander@test.local' });
      const owner = await person('passkey.remove.owner', ['admin']);
      const first = await addFirst();
      const [only] = await passkeyRows(owner);

      await expect(
        passkeys().remove(only.id, await confirm(first, { act: 'remove', passkeyId: only.id }))
      ).rejects.toThrow();
      expect(await passkeyRows(owner)).toHaveLength(1);

      const second = await addAnother(first);
      const [, another] = await passkeyRows(owner);
      const db = getDbAsSystem();
      await db.insert(tables.Session, sessionRow('test-session', owner));
      await db.insert(tables.Session, sessionRow('passkey-remove-phone', owner));
      await db.insert(tables.Session, sessionRow('passkey-remove-bystander', bystander));

      await expect(passkeys().remove(another.id, undefined as unknown as PasskeyConfirmation)).rejects.toThrow();
      // A confirmation is a fresh assertion over ITS OWN challenge: one signed for an earlier step confirms nothing.
      const earlier = await confirm(first, { act: 'remove', passkeyId: another.id });
      const step = await passkeys().beginConfirmation({ act: 'remove', passkeyId: another.id });
      await expect(
        passkeys().remove(another.id, { token: step.token, assertion: earlier.assertion })
      ).rejects.toThrow();
      expect(await passkeyRows(owner)).toHaveLength(2);
      expect(await sessionIdsOf(owner)).toEqual(['passkey-remove-phone', 'test-session']);

      await passkeys().remove(another.id, await confirm(first, { act: 'remove', passkeyId: another.id }));

      expect((await passkeyRows(owner)).map((row) => row.credentialId)).toEqual([first.credentialId]);
      expect(second.credentialId).toBe(another.credentialId);
      expect(await sessionIdsOf(owner)).toEqual(['test-session']);
      expect(await sessionIdsOf(bystander)).toEqual(['passkey-remove-bystander']);
      expect(await passkeyEvents(owner.id)).toEqual([
        { actor: owner.id, field: 'passkeys', value: 'added' },
        { actor: owner.id, field: 'passkeys', value: 'added' },
        { actor: owner.id, field: 'passkeys', value: 'removed' },
      ]);

      // An account that no longer has to use a passkey may let its last one go.
      await getDbAsSystem().update(tables.User, { id: owner.id, roles: [] });
      await passkeys().remove(only.id, await confirm(first, { act: 'remove', passkeyId: only.id }));
      expect(await passkeyRows(owner)).toEqual([]);
    });

    it('a confirmation made for one act is refused for another', async () => {
      const stranger = await person('passkey.purpose.stranger', ['admin']);
      const strangers = await addFirst();
      const owner = await person('passkey.purpose.owner', ['admin']);
      const first = await addFirst();
      await addAnother(first);
      const [one, two] = await passkeyRows(owner);

      await expect(passkeys().remove(two.id, await confirm(first, { act: 'add' }))).rejects.toThrow();
      await expect(
        passkeys().remove(two.id, await confirm(first, { act: 'remove', passkeyId: one.id }))
      ).rejects.toThrow();
      await expect(
        passkeys().remove(two.id, await confirm(first, { act: 'reset', userId: stranger.id }))
      ).rejects.toThrow();
      await expect(passkeys().beginAdd(await confirm(first, { act: 'remove', passkeyId: two.id }))).rejects.toThrow();
      await expect(
        new PasskeyAdmin().reset(stranger.id, await confirm(first, { act: 'reset', userId: owner.id }))
      ).rejects.toThrow();
      await expect(new PasskeyAdmin().reset(stranger.id, await confirm(first, { act: 'add' }))).rejects.toThrow();
      // The act itself is part of what was confirmed, not only what it names: a removal's
      // confirmation that names a person's id is no confirmation of that person's reset.
      await expect(
        new PasskeyAdmin().reset(stranger.id, await confirm(first, { act: 'remove', passkeyId: stranger.id }))
      ).rejects.toThrow();

      // Another account's passkey confirms nothing here: the assertion is read by this account AND its credential.
      const step = await passkeys().beginConfirmation({ act: 'remove', passkeyId: two.id });
      await expect(
        passkeys().remove(two.id, { token: step.token, assertion: strangers.assert(step.options, ORIGIN) })
      ).rejects.toThrow();
      // Nor does a step another account began: its challenge is that account's, whoever signs it.
      testEnv.actAs(stranger);
      const theirs = await passkeys().beginConfirmation({ act: 'remove', passkeyId: two.id });
      testEnv.actAs(owner);
      await expect(
        passkeys().remove(two.id, { token: theirs.token, assertion: first.assert(theirs.options, ORIGIN) })
      ).rejects.toThrow();

      expect(await passkeyRows(owner)).toHaveLength(2);
      expect(await passkeyRows(stranger)).toHaveLength(1);
      expect((await passkeyEvents(owner.id)).map((event) => event.value)).toEqual(['added', 'added']);
      expect((await passkeyEvents(stranger.id)).map((event) => event.value)).toEqual(['added']);
    });

    it('a passkey is its owner’s alone to name or remove: a blank name is refused, and another account’s passkey is neither named nor removed', async () => {
      const stranger = await person('passkey.rename.stranger', ['admin']);
      await addFirst();
      const [strangers] = await passkeyRows(stranger);
      const owner = await person('passkey.rename.owner', ['admin']);
      const first = await addFirst();
      await addAnother(first);
      const [own] = await passkeyRows(owner);

      await passkeys().rename(own.id, '  Work laptop ');
      await expect(passkeys().rename(own.id, '   ')).rejects.toThrow();
      await expect(passkeys().rename(strangers.id, 'Taken')).rejects.toThrow();
      await expect(
        passkeys().remove(strangers.id, await confirm(first, { act: 'remove', passkeyId: strangers.id }))
      ).rejects.toThrow();

      expect((await passkeyRows(owner)).map((row) => row.name)).toEqual(['Work laptop', 'Passkey 2']);
      expect((await passkeyRows(stranger)).map((row) => row.name)).toEqual(['Passkey']);
    });

    it('an act on the passkeys is one transaction: when a later step of it fails, a confirmed add, a removal and a reset leave the passkeys and the sessions as they were and write no audit row', async () => {
      const locked = await person('passkey.atomic.locked', ['roles-desk']);
      await addAnother(await addFirst());
      const admin = await person('passkey.atomic.admin', ['admin']);
      const own = await addFirst();
      await addAnother(own);
      const [, second] = await passkeyRows(admin);
      const db = getDbAsSystem();
      await db.insert(tables.Session, sessionRow('passkey-atomic-admin-phone', admin));
      await db.insert(tables.Session, sessionRow('passkey-atomic-locked-phone', locked));
      const before = { admin: await passkeyEvents(admin.id), locked: await passkeyEvents(locked.id) };

      // A confirmed add whose audit row cannot be written.
      const step = await passkeys().beginAdd(await confirm(own, { act: 'add' }));
      const insert = Db.prototype.insert;
      const auditFails = jest.spyOn(Db.prototype, 'insert').mockImplementation(function (this: any, table, ...rest) {
        return table.name === tables.UserAccountEvent.name
          ? Promise.reject(new Error('the audit row could not be written'))
          : insert.call(this, table, ...rest);
      });
      try {
        await expect(
          passkeys().finishAdd(step.token, new SoftwareAuthenticator().register(step.options, ORIGIN))
        ).rejects.toThrow();
      } finally {
        auditFails.mockRestore();
      }

      // A removal, then a reset, whose end of sessions fails.
      const sessionsFail = (method: 'endOthers' | 'endAll') =>
        jest.spyOn(AccountSessions.prototype, method).mockRejectedValue(new Error('the sessions could not be ended'));
      const removalFails = sessionsFail('endOthers');
      try {
        await expect(
          passkeys().remove(second.id, await confirm(own, { act: 'remove', passkeyId: second.id }))
        ).rejects.toThrow();
      } finally {
        removalFails.mockRestore();
      }
      const resetFails = sessionsFail('endAll');
      try {
        await expect(
          new PasskeyAdmin().reset(locked.id, await confirm(own, { act: 'reset', userId: locked.id }))
        ).rejects.toThrow();
      } finally {
        resetFails.mockRestore();
      }

      expect(await passkeyRows(admin)).toHaveLength(2);
      expect(await passkeyRows(locked)).toHaveLength(2);
      expect(await passkeyEvents(admin.id)).toEqual(before.admin);
      expect(await passkeyEvents(locked.id)).toEqual(before.locked);
      expect(await sessionIdsOf(admin)).toEqual(['passkey-atomic-admin-phone']);
      expect(await sessionIdsOf(locked)).toEqual(['passkey-atomic-locked-phone']);
    });

    it('reset: the admin is refused on their own account and on a declared machine account; on another person it deletes the passkeys, ends that person’s sessions and nobody else’s, and writes one audit row', async () => {
      const locked = await person('passkey.reset.locked', ['roles-desk']);
      const lost = await addFirst();
      await addAnother(lost);
      const machine = await testEnv.createUser({ name: 'Machine', email: 'passkey.reset.machine@test.local' });
      await getDbAsSystem().update(tables.User, { id: machine.id, isLoadedFromSource: true, roles: ['admin'] });
      const admin = await person('passkey.reset.admin', ['admin']);
      const own = await addFirst();
      const db = getDbAsSystem();
      await db.insert(tables.Session, sessionRow('passkey-reset-locked-phone', locked));
      await db.insert(tables.Session, sessionRow('passkey-reset-locked-laptop', locked));
      await db.insert(tables.Session, sessionRow('passkey-reset-admin', admin));
      expect(await new PasskeyAdmin().count(locked.id)).toBe(2);

      await expect(
        new PasskeyAdmin().reset(admin.id, await confirm(own, { act: 'reset', userId: admin.id }))
      ).rejects.toThrow();
      await expect(
        new PasskeyAdmin().reset(machine.id, await confirm(own, { act: 'reset', userId: machine.id }))
      ).rejects.toThrow();
      await expect(new PasskeyAdmin().reset(locked.id, undefined as unknown as PasskeyConfirmation)).rejects.toThrow();
      expect(await passkeyRows(admin)).toHaveLength(1);
      expect(await passkeyRows(locked)).toHaveLength(2);
      expect(await sessionIdsOf(locked)).toEqual(['passkey-reset-locked-laptop', 'passkey-reset-locked-phone']);

      await new PasskeyAdmin().reset(locked.id, await confirm(own, { act: 'reset', userId: locked.id }));

      expect(await passkeyRows(locked)).toEqual([]);
      expect(await new PasskeyAdmin().count(locked.id)).toBe(0);
      expect(await sessionIdsOf(locked)).toEqual([]);
      expect(await sessionIdsOf(admin)).toEqual(['passkey-reset-admin']);
      expect(await passkeyRows(admin)).toHaveLength(1);
      expect(await passkeyEvents(locked.id)).toEqual([
        { actor: locked.id, field: 'passkeys', value: 'added' },
        { actor: locked.id, field: 'passkeys', value: 'added' },
        { actor: admin.id, field: 'passkeys', value: 'reset' },
      ]);

      // Nothing left to reset: asked again it changes nothing and records nothing.
      await new PasskeyAdmin().reset(locked.id, await confirm(own, { act: 'reset', userId: locked.id }));
      expect(await passkeyEvents(locked.id)).toHaveLength(3);
    });
  });
});
