import { createServer } from 'http';
import moment from 'moment';
import { Db, getDbAsSystem } from '@proteinjs/db';
import { EmailSender, MailSink } from '@proteinjs/email-server';
import { Logger } from '@proteinjs/logger';
import { SourceRepository } from '@proteinjs/reflection';
import { SocketIOServerRepo } from '@proteinjs/server';
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
import { DefaultAdminCredentials } from '../src/authentication/DefaultAdminCredentials';
import { EmailVerificationToken } from '../src/authentication/EmailVerificationToken';
import { PasskeyEmails } from '../src/emails/PasskeyEmails';
import { SocketIOSessionWatcher } from '../src/authentication/SocketIOSessionWatcher';
import { PasskeyAdmin } from '../src/services/PasskeyAdmin';
import { Passkeys } from '../src/services/Passkeys';
import { UserAccountAdmin } from '../src/services/UserAccountAdmin';
import { LogCapture } from './LogCapture';
import { sha256Hex } from './sha256Hex';
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

  it(`setEmail refuses a malformed address, an address another account holds — a row's, or the built-in default admin's, which holds its address with no row — and a machine account: nothing written`, async () => {
    const target = await testEnv.createUser({ name: 'Holder', email: 'holder@test.local' });
    const other = await testEnv.createUser({ name: 'Other', email: 'other@test.local' });
    const machine = await testEnv.createUser({ name: 'Machine', email: 'machine@test.local' });
    await getDbAsSystem().update(tables.User, { id: machine.id, isLoadedFromSource: true });

    await expect(service().setEmail(target.id, 'not-an-address')).rejects.toThrow(/valid email/i);
    await expect(service().setEmail(target.id, 'Other@test.local')).rejects.toThrow(/another account/i);
    await expect(service().setEmail(machine.id, 'renamed.machine@test.local')).rejects.toThrow(/machine account/i);
    const credentials = DefaultAdminCredentials as unknown as {
      CREDENTIALS?: { username: string; password: string };
    };
    credentials.CREDENTIALS = { username: 'Built-In.Admin@test.local', password: 'a-bootstrap-password' };
    try {
      await expect(service().setEmail(target.id, 'built-in.ADMIN@test.local')).rejects.toThrow(/another account/i);
    } finally {
      credentials.CREDENTIALS = undefined;
    }

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
   * session; each act is one transaction with its audit row, and once it has committed the
   * account is mailed (the process's mail sink stands in for a transport, and the suite registers
   * the app's seam for the mail's words: a subject that says which change it tells of).
   */
  describe('the passkey services, with a relying party declared', () => {
    const RELYING_PARTY = { id: 'example.test', origin: 'https://app.example.test', name: 'Example' };
    const RELYING_PARTY_KEY = '@proteinjs/user-server/PasskeyRelyingParty';
    const MAIL_SENDER_KEY = '@proteinjs/email-server/DefaultEmailConfigFactory';
    const PASSKEY_MAIL_KEY = '@proteinjs/user-server/DefaultPasskeyChangedEmailConfigFactory';
    const ORIGIN = { origin: RELYING_PARTY.origin };
    // The app's seam: its own words for each change. Its options never redirect or copy the mail.
    const passkeyMail = {
      getConfig: () => ({
        options: { to: 'elsewhere@test.local', cc: 'copied@test.local', bcc: 'hidden@test.local' },
        getEmailContent: (change: string) => ({ subject: `passkey ${change}`, text: `A passkey was ${change}.` }),
      }),
    };
    const originalTransport = process.env.EMAIL_TRANSPORT;
    const objectCache = () =>
      (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache;
    const passkeys = () => new Passkeys();
    const passkeyRows = async (user: User) =>
      (await getDbAsSystem().query(tables.UserPasskey, { scope: user.id })).sort(
        (a, b) => a.created.valueOf() - b.created.valueOf()
      );
    const passkeyEvents = async (target: string) =>
      (await events(target)).filter((event) => event.field === 'passkeys');
    /** The subjects of the mails `user`'s address was sent, oldest first. */
    const mailed = (user: User) =>
      MailSink.get()
        .list()
        .filter((mail) => mail.to.includes(user.email))
        .map((mail) => mail.subject)
        .reverse();
    const sessionIdsOf = async (user: User) =>
      (await getDbAsSystem().query(tables.Session, { userEmail: user.email }))
        .map((session) => session.sessionId)
        .sort();

    /**
     * An act answers without waiting for its mail, so a case that reads the sink or the log first
     * waits for every telling the acts so far have started (each resolves when its send has ended).
     */
    let tellings: jest.SpyInstance<Promise<void>, Parameters<PasskeyEmails['tell']>>;
    const mailsSettle = async () => {
      await Promise.all(tellings.mock.results.map((telling) => telling.value));
    };

    /** What `act` came to inside two seconds: it answered, or it is still waiting. */
    const within2s = async (act: Promise<unknown>): Promise<'answered' | 'still waiting'> => {
      let stopWaiting = () => {};
      const waited = new Promise<'still waiting'>((resolve) => {
        const timer = setTimeout(() => resolve('still waiting'), 2000);
        stopWaiting = () => clearTimeout(timer);
      });
      try {
        return await Promise.race([act.then(() => 'answered' as const), waited]);
      } finally {
        stopWaiting();
      }
    };

    /** The account's open challenges, by what each was made for. */
    const openSteps = async (user: User) =>
      (await getDbAsSystem().query(tables.AuthChallenge, { userId: user.id }))
        .filter((challenge) => !challenge.consumedAt)
        .map((challenge) => (challenge.payload as { purpose: string }).purpose)
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

    /** Run `act` with the clock every challenge and passkey row is read and stamped by set to `now`. */
    const at = async <T>(now: moment.Moment, act: () => Promise<T>): Promise<T> => {
      const clock = jest.spyOn(moment, 'now').mockReturnValue(now.valueOf());
      try {
        return await act();
      } finally {
        clock.mockRestore();
      }
    };

    /** Whether a transaction is open where this is asked (the ambient context every Db shares). */
    const transactionOpen = () =>
      Boolean(
        (
          getDbAsSystem() as unknown as {
            transactionContextFactory: { getTransactionContext: () => { currentTransaction?: unknown } };
          }
        ).transactionContextFactory.getTransactionContext().currentTransaction
      );

    /**
     * Run `acts` with the Session table's real watcher registered and a socket server that records
     * what it is asked to close, and whether a transaction was still open when it was asked. The
     * watcher map is a static of a class @proteinjs/db does not export, so it is reset through a Db
     * instance; everything is put back as it was found.
     */
    const withSessionSockets = async (
      acts: (asked: { rooms: string[]; insideATransaction: boolean }[]) => Promise<void>
    ) => {
      const WATCHERS = '@proteinjs/db/TableWatcher';
      const SOCKET_SERVER = '@proteinjs/event/DefaultSocketIOServerFactory';
      const resetTableWatcherMap = () => {
        const runner = (getDbAsSystem() as unknown as { tableWatcherRunner: object }).tableWatcherRunner;
        (runner.constructor as { tableWatcherMap?: unknown }).tableWatcherMap = undefined;
      };
      const asked: { rooms: string[]; insideATransaction: boolean }[] = [];
      const socketServer = {
        in: (rooms: string | string[]) => ({
          disconnectSockets: () => {
            asked.push({ rooms: ([] as string[]).concat(rooms), insideATransaction: transactionOpen() });
          },
        }),
      };
      const watchers = objectCache()[WATCHERS];
      objectCache()[WATCHERS] = [new SocketIOSessionWatcher()];
      resetTableWatcherMap();
      objectCache()[SOCKET_SERVER] = [{ createSocketIOServer: async () => socketServer }];
      await SocketIOServerRepo.createSocketIOServer(createServer());
      try {
        await acts(asked);
      } finally {
        delete (globalThis as { __proteinjs_server_SocketIOServer?: unknown }).__proteinjs_server_SocketIOServer;
        delete objectCache()[SOCKET_SERVER];
        if (watchers === undefined) {
          delete objectCache()[WATCHERS];
        } else {
          objectCache()[WATCHERS] = watchers;
        }
        resetTableWatcherMap();
      }
    };

    beforeAll(() => {
      objectCache()[RELYING_PARTY_KEY] = [{ getRelyingParty: () => RELYING_PARTY }];
      process.env.EMAIL_TRANSPORT = 'sink';
      objectCache()[MAIL_SENDER_KEY] = [
        {
          getEmailConfig: () => ({
            host: 'smtp.test.local',
            port: 465,
            secure: true,
            from: '"Example" <hi@example.com>',
          }),
        },
      ];
      objectCache()[PASSKEY_MAIL_KEY] = [passkeyMail];
      tellings = jest.spyOn(PasskeyEmails.prototype, 'tell');
    });

    afterAll(() => {
      tellings.mockRestore();
      objectCache()[RELYING_PARTY_KEY] = [];
      delete objectCache()[MAIL_SENDER_KEY];
      delete objectCache()[PASSKEY_MAIL_KEY];
      if (originalTransport === undefined) {
        delete process.env.EMAIL_TRANSPORT;
      } else {
        process.env.EMAIL_TRANSPORT = originalTransport;
      }
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
      // The owner's list shows them oldest first.
      expect((await passkeys().list()).passkeys.map((passkey) => passkey.id)).toEqual(rows.map((row) => row.id));
      // A credential that is already a passkey adds nothing, and is refused in the service's own
      // words: the table's refusal, which names its key, never reaches the caller.
      const taken = await passkeys().beginAdd(await confirm(first, { act: 'add' }));
      const refusal = await passkeys()
        .finishAdd(taken.token, second.register(taken.options, ORIGIN))
        .then(
          () => 'added',
          (error: Error) => error.message
        );
      expect(refusal).not.toBe('added');
      expect(refusal).not.toMatch(/user_passkey|unique|index/i);
      expect(await passkeyRows(owner)).toHaveLength(2);
      expect(await passkeyEvents(owner.id)).toEqual([
        { actor: owner.id, field: 'passkeys', value: 'added' },
        { actor: owner.id, field: 'passkeys', value: 'added' },
      ]);

      // Adding is for an account that must use a passkey: one that holds no administrative role is refused.
      const ordinary = await person('passkey.add.ordinary', ['people-desk']);
      await expect(passkeys().beginAdd()).rejects.toThrow();
      expect(await passkeyRows(ordinary)).toEqual([]);
      // And an add begun while the account had to use one adds nothing once it need not.
      const leaving = await person('passkey.add.leaving', ['admin']);
      const begun = await passkeys().beginAdd();
      await getDbAsSystem().update(tables.User, { id: leaving.id, roles: [] });
      await expect(
        passkeys().finishAdd(begun.token, new SoftwareAuthenticator().register(begun.options, ORIGIN))
      ).rejects.toThrow();
      expect(await passkeyRows(leaving)).toEqual([]);
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

    it('a confirmation and an add step are each good for five minutes from their minting — answered a moment before, each holds; a moment after, each is refused — and a confirmation records the passkey’s use', async () => {
      const owner = await person('passkey.life.owner', ['admin']);
      const first = await addFirst();
      expect((await passkeyRows(owner))[0].lastUsedAt ?? null).toBeNull();
      const fiveMinutesFrom = (minted: moment.Moment, seconds: number) =>
        minted.clone().add(5, 'minutes').add(seconds, 'seconds');
      const another = (step: { options: Parameters<SoftwareAuthenticator['register']>[0] }) =>
        new SoftwareAuthenticator().register(step.options, ORIGIN);

      // A confirmation answered a moment before its five minutes are up confirms, and the passkey
      // that answered it is recorded as used then: its counter, and that moment as its last use.
      let minted = moment();
      const held = await confirm(first, { act: 'add' });
      const justInside = fiveMinutesFrom(minted, -20);
      const step = await at(justInside, () => passkeys().beginAdd(held));
      const [used] = await passkeyRows(owner);
      expect(used.counter).toBe(first.signatureCount);
      expect(used.lastUsedAt?.valueOf()).toBe(justInside.valueOf());

      // The add step it opened was minted at that moment: a moment after ITS five minutes it adds nothing.
      await expect(
        at(fiveMinutesFrom(justInside, 20), () => passkeys().finishAdd(step.token, another(step)))
      ).rejects.toThrow();
      expect(await passkeyRows(owner)).toHaveLength(1);

      // A confirmation answered a moment after its five minutes confirms nothing.
      minted = moment();
      const late = await confirm(first, { act: 'add' });
      await expect(at(fiveMinutesFrom(minted, 20), () => passkeys().beginAdd(late))).rejects.toThrow();

      // And an add step answered a moment before its five minutes adds the passkey.
      minted = moment();
      const open = await passkeys().beginAdd(await confirm(first, { act: 'add' }));
      await at(fiveMinutesFrom(minted, -20), () => passkeys().finishAdd(open.token, another(open)));
      expect(await passkeyRows(owner)).toHaveLength(2);
    });

    it('a challenge made in a session knows its session by the SHA-256 of the session id: its row never holds the id', async () => {
      const SESSION = 'a-session-id-is-a-credential';
      const owner = await person('passkey.rest.owner', ['admin']);
      const first = await addFirst();
      ride(SESSION);
      await passkeys().beginAdd(await confirm(first, { act: 'add' }));

      const rows = await getDbAsSystem().query(tables.AuthChallenge, { userId: owner.id });
      const madeInIt = rows.filter((row) => (row.payload as { session?: string }).session === sha256Hex(SESSION));
      expect(madeInIt.map((row) => row.kind).sort()).toEqual(['webauthn_login', 'webauthn_register']);
      expect(JSON.stringify(rows)).not.toContain(SESSION);
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
      const bystander = await testEnv.createUser({ name: 'Bystander', email: 'passkey.purpose.bystander@test.local' });
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
        new PasskeyAdmin().reset(stranger.id, await confirm(first, { act: 'reset', userId: bystander.id }))
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

    it('an act on the passkeys is one transaction: when a later step of it fails, a confirmed add, a removal and a reset leave the passkeys and the sessions as they were, write no audit row and mail nobody', async () => {
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
      MailSink.get().clear();

      // A confirmed add whose audit row cannot be written.
      const step = await passkeys().beginAdd(await confirm(own, { act: 'add' }));
      const insert = Db.prototype.insert;
      const auditFails = jest.spyOn(Db.prototype, 'insert').mockImplementation(function (this: any, table, ...rest) {
        return table.name === tables.UserAccountEvent.name
          ? Promise.reject(new Error('the audit row could not be written'))
          : insert.call(this, table, ...rest);
      });
      try {
        // The failure itself reaches the caller: only a credential that is already a passkey is
        // answered as a refusal in the service's words.
        await expect(
          passkeys().finishAdd(step.token, new SoftwareAuthenticator().register(step.options, ORIGIN))
        ).rejects.toThrow('the audit row could not be written');
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
      await mailsSettle();
      expect(MailSink.get().list()).toEqual([]);
    });

    it('a socket is closed only for a session that is truly gone: a reset that rolls back asks the socket server nothing, and a removal that commits asks it for the ended session once its transaction has committed', async () => {
      const locked = await person('passkey.sockets.locked', ['roles-desk']);
      await addFirst();
      const admin = await person('passkey.sockets.admin', ['admin']);
      const own = await addFirst();
      await addAnother(own);
      const [, second] = await passkeyRows(admin);
      const db = getDbAsSystem();
      await db.insert(tables.Session, sessionRow('test-session', admin));
      await db.insert(tables.Session, sessionRow('passkey-sockets-admin-phone', admin));
      await db.insert(tables.Session, sessionRow('passkey-sockets-locked-phone', locked));
      const reset = await confirm(own, { act: 'reset', userId: locked.id });
      const removal = await confirm(own, { act: 'remove', passkeyId: second.id });

      const askedBy = { theResetThatRolledBack: [] as unknown[], theRemovalThatCommitted: [] as unknown[] };
      await withSessionSockets(async (asked) => {
        // A reset whose audit row cannot be written: the person's session row is deleted inside
        // the transaction, and the transaction then rolls back.
        const insert = Db.prototype.insert;
        const auditFails = jest.spyOn(Db.prototype, 'insert').mockImplementation(function (this: any, table, ...rest) {
          return table.name === tables.UserAccountEvent.name
            ? Promise.reject(new Error('the audit row could not be written'))
            : insert.call(this, table, ...rest);
        });
        try {
          await expect(new PasskeyAdmin().reset(locked.id, reset)).rejects.toThrow();
        } finally {
          auditFails.mockRestore();
        }
        askedBy.theResetThatRolledBack = asked.splice(0);

        await passkeys().remove(second.id, removal);
        askedBy.theRemovalThatCommitted = asked.splice(0);
      });

      expect(await passkeyRows(locked)).toHaveLength(1);
      expect(await sessionIdsOf(locked)).toEqual(['passkey-sockets-locked-phone']);
      expect(await passkeyRows(admin)).toHaveLength(1);
      expect(await sessionIdsOf(admin)).toEqual(['test-session']);
      expect(askedBy).toEqual({
        theResetThatRolledBack: [],
        theRemovalThatCommitted: [{ rooms: ['passkey-sockets-admin-phone'], insideATransaction: false }],
      });
    });

    it('each act on an account’s passkeys mails the account’s address once — a passkey added, one removed, all of them reset — and an act that is refused mails nothing', async () => {
      const locked = await person('passkey.mail.locked', ['roles-desk']);
      await mailsSettle();
      MailSink.get().clear();
      const wire = jest.spyOn(MailSink.get(), 'record');
      try {
        const first = await addFirst();
        await addAnother(first);
        const [, another] = await passkeyRows(locked);
        await expect(passkeys().remove(another.id, undefined as unknown as PasskeyConfirmation)).rejects.toThrow();
        await mailsSettle();
        expect(mailed(locked)).toEqual(['passkey added', 'passkey added']);

        await passkeys().remove(another.id, await confirm(first, { act: 'remove', passkeyId: another.id }));
        const admin = await person('passkey.mail.admin', ['admin']);
        const own = await addFirst();
        await new PasskeyAdmin().reset(locked.id, await confirm(own, { act: 'reset', userId: locked.id }));
        await mailsSettle();

        expect(mailed(locked)).toEqual(['passkey added', 'passkey added', 'passkey removed', 'passkey reset']);
        expect(mailed(admin)).toEqual(['passkey added']);
        expect(MailSink.get().list()).toHaveLength(5);
        // The account's address is the mail's only recipient: the app's options add nobody.
        expect(wire.mock.calls.map(([message]) => [message.cc, message.bcc])).toEqual(
          Array.from({ length: 5 }, () => [undefined, undefined])
        );
      } finally {
        wire.mockRestore();
      }
    });

    it('an act does not wait for its mail: with a sender that never settles, an add, a removal and a reset each answer, and each has happened', async () => {
      const locked = await person('passkey.waits.locked', ['roles-desk']);
      await addFirst();
      const admin = await person('passkey.waits.admin', ['admin']);
      const neverSettles = jest
        .spyOn(EmailSender.prototype, 'sendEmail')
        .mockReturnValue(new Promise<void>(() => undefined));
      const answered = { theAdd: '', theRemoval: '', theReset: '' };
      try {
        const own = new SoftwareAuthenticator();
        answered.theAdd = await within2s(addFirst(own));
        await within2s(addAnother(own));
        const [, second] = await passkeyRows(admin);
        answered.theRemoval = await within2s(
          passkeys().remove(second.id, await confirm(own, { act: 'remove', passkeyId: second.id }))
        );
        answered.theReset = await within2s(
          new PasskeyAdmin().reset(locked.id, await confirm(own, { act: 'reset', userId: locked.id }))
        );
      } finally {
        neverSettles.mockRestore();
        // Those tellings never end: the cases after this one wait only for their own.
        tellings.mockClear();
      }

      expect(answered).toEqual({ theAdd: 'answered', theRemoval: 'answered', theReset: 'answered' });
      expect(await passkeyRows(admin)).toHaveLength(1);
      expect(await passkeyRows(locked)).toEqual([]);
    });

    it('a mail that cannot be sent is one error line that names the account by digest, never its address, and the act stands', async () => {
      const owner = await person('passkey.mail.unsent', ['admin']);
      objectCache()[PASSKEY_MAIL_KEY] = [
        {
          getConfig: () => {
            throw new Error(`no words today for ${owner.email}`);
          },
        },
      ];
      MailSink.get().clear();
      let log: LogCapture;
      try {
        log = await LogCapture.during(async () => {
          await addFirst();
          await mailsSettle();
        });
      } finally {
        objectCache()[PASSKEY_MAIL_KEY] = [passkeyMail];
      }

      expect(await passkeyRows(owner)).toHaveLength(1);
      expect(await passkeyEvents(owner.id)).toHaveLength(1);
      expect(MailSink.get().list()).toEqual([]);
      const failures = log.linesContaining('Passkey mail failed to send');
      expect(failures.lines).toHaveLength(1);
      expect(failures.addresses).toEqual([]);
      expect(log.addresses).toEqual([]);
      // The passkey lines name the account by one name, its digest: the service's line and the mail's agree.
      const accountOn = (marker: string) =>
        /account: '([0-9a-f]{16})'/.exec(
          log.linesContaining(marker).text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
        )?.[1];
      expect(accountOn('Passkey added')).toMatch(/^[0-9a-f]{16}$/);
      expect(accountOn('Passkey added')).toBe(accountOn('Passkey mail failed to send'));
    });

    it('a mail that cannot be sent, whose error line cannot be written either, is thrown nowhere: the telling still ends, on one bare line that carries nothing of the error', async () => {
      const owner = await person('passkey.mail.unwritable', ['admin']);
      objectCache()[PASSKEY_MAIL_KEY] = [
        {
          getConfig: () => {
            throw new Error(`no words today for ${owner.email}`);
          },
        },
      ];
      const writeLine = Logger.prototype.error;
      const lineFails = jest.spyOn(Logger.prototype, 'error').mockImplementation(function (this: Logger, entry) {
        if (entry.message === 'Passkey mail failed to send') {
          throw new Error(`the line could not be written for ${owner.email}`);
        }
        return writeLine.call(this, entry);
      });
      // What an act starts and does not await: were it to reject, nothing would catch it.
      let told: unknown;
      let log: LogCapture;
      try {
        log = await LogCapture.during(async () => {
          told = await new PasskeyEmails().tell(owner.id, 'added').then(
            () => 'ended',
            (thrown) => thrown
          );
        });
      } finally {
        lineFails.mockRestore();
        objectCache()[PASSKEY_MAIL_KEY] = [passkeyMail];
      }

      expect(told).toBe('ended');
      expect(log.linesContaining('Passkey mail').lines).toHaveLength(1);
      expect(log.addresses).toEqual([]);
      expect(log.text).not.toContain('no words today');
      expect(
        MailSink.get()
          .list()
          .filter((mail) => mail.to.includes(owner.email))
      ).toEqual([]);
    });

    it('a session holds at most one open step per act: twenty begins leave one, and only the last confirms; a step that cannot be written leaves the open one standing; a begin that will be refused — a reset’s by a person who may not reset among them, who is told the same words whether or not the id names an account — leaves none', async () => {
      const owner = await person('passkey.bound.owner', ['admin']);
      const first = await addFirst();
      const [row] = await passkeyRows(owner);
      const answer = (step: Awaited<ReturnType<Passkeys['beginConfirmation']>>) => ({
        token: step.token,
        assertion: first.assert(step.options, ORIGIN),
      });

      const steps = [];
      for (let begun = 0; begun < 20; begun++) {
        steps.push(await passkeys().beginConfirmation({ act: 'add' }));
      }
      expect(await openSteps(owner)).toEqual(['confirm-add']);
      await expect(passkeys().beginAdd(answer(steps[18]))).rejects.toThrow();

      // Another session's step, and this session's step for another act, replace nothing.
      ride('another-session');
      await passkeys().beginConfirmation({ act: 'add' });
      ride('test-session');
      await passkeys().beginConfirmation({ act: 'remove', passkeyId: row.id });
      expect(await openSteps(owner)).toEqual(['confirm-add', 'confirm-add', 'confirm-remove']);

      // A new step that cannot be written replaces nothing: the open one still confirms.
      const insert = Db.prototype.insert;
      const stepFails = jest.spyOn(Db.prototype, 'insert').mockImplementation(function (this: any, table, ...rest) {
        return table.name === tables.AuthChallenge.name
          ? Promise.reject(new Error('the step could not be written'))
          : insert.call(this, table, ...rest);
      });
      try {
        await expect(passkeys().beginConfirmation({ act: 'add' })).rejects.toThrow();
      } finally {
        stepFails.mockRestore();
      }
      expect((await passkeys().beginAdd(answer(steps[19]))).token).toBeTruthy();

      // A begin that will be refused writes no step: an account with no passkey to confirm with,
      // and an account that need not use a passkey — whether or not it has one.
      const bare = await person('passkey.bound.bare', ['admin']);
      await expect(passkeys().beginConfirmation({ act: 'add' })).rejects.toThrow();
      expect(await openSteps(bare)).toEqual([]);
      const ordinary = await person('passkey.bound.ordinary', ['people-desk']);
      await expect(passkeys().beginAdd()).rejects.toThrow();
      expect(await openSteps(ordinary)).toEqual([]);
      // Nor does a reset's confirmation begun by a person who may not reset — one who has a passkey
      // to answer it with, and not the admin role: the right is asked before the step is written,
      // and before any account is read — the refusal's words are the same for an id that names
      // nobody, so they say nothing of whether an id names an account.
      const desk = await person('passkey.bound.desk', ['roles-desk']);
      await addFirst();
      const refusedInTheWords = (userId: string) =>
        passkeys()
          .beginConfirmation({ act: 'reset', userId })
          .then(
            () => {
              throw new Error('a reset’s confirmation was begun by a person who may not reset');
            },
            (refusal: Error) => refusal.message
          );
      const told = await refusedInTheWords(bare.id);
      expect(told).toBeTruthy();
      expect(await refusedInTheWords('an-id-that-names-nobody')).toBe(told);
      expect(await openSteps(desk)).toEqual([]);
      testEnv.actAs(owner);
      await getDbAsSystem().update(tables.User, { id: owner.id, roles: [] });
      const open = await openSteps(owner);
      await expect(passkeys().beginConfirmation({ act: 'add' })).rejects.toThrow();
      expect(await openSteps(owner)).toEqual(open);
    });

    it('count: one answer per account — how many passkeys it holds, whether it must use one (the gate’s rule) and whether the caller may reset them (the reset’s rule): an administrative account with two, an account that need not use one, a declared machine account, the caller’s own; the built-in default admin, which has no account row, is answered and may reset nobody', async () => {
      const locked = await person('passkey.count.locked', ['roles-desk']);
      const lost = await addFirst();
      await addAnother(lost);
      const ordinary = await testEnv.createUser({
        name: 'Ordinary',
        email: 'passkey.count.ordinary@test.local',
        roles: ['people-desk'],
      });
      const machine = await testEnv.createUser({ name: 'Machine', email: 'passkey.count.machine@test.local' });
      await getDbAsSystem().update(tables.User, { id: machine.id, isLoadedFromSource: true, roles: ['admin'] });
      const admin = await person('passkey.count.admin', ['admin']);
      await addFirst();
      const count = (userId: string) => new PasskeyAdmin().count(userId);

      expect(await count(locked.id)).toEqual({ count: 2, required: true, mayReset: true });
      expect(await count(ordinary.id)).toEqual({ count: 0, required: false, mayReset: true });
      expect(await count(machine.id)).toEqual({ count: 0, required: false, mayReset: false });
      expect(await count(admin.id)).toEqual({ count: 1, required: true, mayReset: false });

      // The built-in default admin holds `admin` with no account row: the door admits it, and the
      // answer is whole — but the reset itself refuses a caller with no row, so it may reset nobody.
      const credentials = DefaultAdminCredentials as unknown as {
        CREDENTIALS?: { username: string; password: string };
      };
      credentials.CREDENTIALS = { username: 'built-in.admin@test.local', password: 'a-bootstrap-password' };
      try {
        testEnv.actAs(DefaultAdminCredentials.identityOf('built-in.admin@test.local')!);
        expect(await count(locked.id)).toEqual({ count: 2, required: true, mayReset: false });
      } finally {
        credentials.CREDENTIALS = undefined;
      }
    });

    it('reset: the admin is refused on their own account and on a declared machine account, where its confirmation is begun and at the reset itself, with nothing written or spent; on another person it deletes the passkeys, ends that person’s sessions and nobody else’s, and writes one audit row', async () => {
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
      expect(await new PasskeyAdmin().count(locked.id)).toMatchObject({ count: 2 });

      // The admin's own account and a machine account are refused where the confirmation is begun,
      // with no step written — and again at the reset itself, before a confirmation is spent: the
      // one made for the locked person is still good after both refusals.
      const forLocked = await confirm(own, { act: 'reset', userId: locked.id });
      for (const refused of [admin, machine]) {
        await expect(passkeys().beginConfirmation({ act: 'reset', userId: refused.id })).rejects.toThrow();
        await expect(new PasskeyAdmin().reset(refused.id, forLocked)).rejects.toThrow();
      }
      expect(await openSteps(admin)).toEqual(['confirm-reset']);
      await expect(new PasskeyAdmin().reset(locked.id, undefined as unknown as PasskeyConfirmation)).rejects.toThrow();
      expect(await passkeyRows(admin)).toHaveLength(1);
      expect(await passkeyRows(locked)).toHaveLength(2);
      expect(await sessionIdsOf(locked)).toEqual(['passkey-reset-locked-laptop', 'passkey-reset-locked-phone']);

      await new PasskeyAdmin().reset(locked.id, forLocked);

      expect(await passkeyRows(locked)).toEqual([]);
      expect(await new PasskeyAdmin().count(locked.id)).toMatchObject({ count: 0 });
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
