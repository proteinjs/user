import moment from 'moment';
import sha256 from 'crypto-js/sha256';
import { SourceRecordSyncRunner, getDbAsSystem } from '@proteinjs/db';
import { EmailSender, MailSink } from '@proteinjs/email-server';
import { SourceRepository } from '@proteinjs/reflection';
import { MachineAccount, RoleCatalogEntry, UserRepo, tables } from '@proteinjs/user';
import { RequestDigests } from '@proteinjs/util-node';
import { authenticate } from '../src/authentication/authenticate';
import { PasswordResetToken } from '../src/authentication/PasswordResetToken';
import { UserStatusTableWatcher } from '../src/authentication/UserStatusTableWatcher';
import { userCache } from '../src/authorization/userCache';
import { executePasswordReset } from '../src/routes/executePasswordReset';
import { initiatePasswordReset } from '../src/routes/initiatePasswordReset';
import { validateResetPasswordToken } from '../src/routes/validateResetPasswordToken';
import { MachineCredentials } from '../src/services/MachineCredentials';
import { Signup } from '../src/services/Signup';
import { invokeDevLogin } from './devLoginHarness';
import { LogCapture } from './LogCapture';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * No e-mail address reaches the server log from the doors that handle one — every line that names
 * a person names them by a keyed digest (`RequestDigests`, from `@proteinjs/util-node`): the
 * account digest for an account (or the address a sign-in or reset door was asked about), the
 * address digest for a bare address (an invitee); the mail lines beside them (the email server's)
 * add the recipient's domain. Driven end to end against the Spanner emulator and the mail sink, the log captured as
 * the default writer emits it (every console level, every logger), on every path through:
 * - the reset door: an unknown address, a mailed link, a repeat inside five minutes, a failed send;
 * - the reset link: redeemed, presented again, expired, and an expired link validated;
 * - an invite: sent, re-sent, a send that fails, a re-send that fails;
 * - signup: an account created, then the same address again;
 * - sign-in and sessions: a deactivated account refused, a session on a deactivated account, a
 *   session on a missing account;
 * - the sessions a deactivation kills, and a minted machine credential;
 * - the dev doors: a missing test account created, the first-admin grant, a session established.
 *
 * The one line that keeps an address is the dev role-bootstrap door's `[dev-bootstrap]` marker —
 * development only, and read back by address by the development tooling — so it is closed here.
 */

type RouteOutcome = { status: number; body?: any };

const invoke = async (
  route: { onRequest: (request: never, response: never) => Promise<void> },
  request: Record<string, unknown>
): Promise<RouteOutcome> => {
  const outcome: RouteOutcome = { status: 200 };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body;
    },
  };
  await route.onRequest(request as never, response as never);
  return outcome;
};

type SourceRepositoryInternals = {
  objectCache: Record<string, unknown[]>;
  namedObjectCache: Record<string, { qualifiedName: string; packageName: string; object: unknown }[]>;
};

const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
const namedObjectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).namedObjectCache;

/** The deactivation watcher map is built once per process from the cache; rebuild it from what is seeded now. */
const resetTableWatcherMap = () => {
  const runner = (getDbAsSystem() as unknown as { tableWatcherRunner: object }).tableWatcherRunner;
  (runner.constructor as { tableWatcherMap?: unknown }).tableWatcherMap = undefined;
};

class OpsRole implements RoleCatalogEntry {
  role = 'ops';
  description = 'Operational machinery';
}

class LogsMachineAccount extends MachineAccount {
  id = 'machine-logs-ops';
  email = 'machine-logs@test.local';
  accountName = 'Logs ops machine';
  roles = ['ops'];
  secretName = 'logs-ops-secret';
}

const DEV_ENV = ['DEVELOPMENT', 'DEV_AUTO_LOGIN_EMAIL', 'DEV_BOOTSTRAP_ADMIN_EMAIL', 'DEV_BOOTSTRAP_ROLES'] as const;

describe('no e-mail address reaches the server log', () => {
  const digests = new RequestDigests();
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await testEnv.beforeAll();
    for (const key of ['EMAIL_TRANSPORT', ...DEV_ENV]) {
      originalEnv[key] = process.env[key];
    }
    process.env.EMAIL_TRANSPORT = 'sink';
    const cache = objectCache();
    cache['@proteinjs/email-server/DefaultEmailConfigFactory'] = [
      {
        getEmailConfig: () => ({
          host: 'smtp.test.local',
          port: 465,
          secure: true,
          from: '"Example" <hi@example.com>',
        }),
      },
    ];
    cache['@proteinjs/email-server/DefaultPasswordResetEmailConfigFactory'] = [
      { getConfig: () => ({ getEmailContent: (path: string) => ({ text: `Reset: https://app.test.local/${path}` }) }) },
    ];
    cache['@proteinjs/email-server/DefaultInviteEmailConfigFactory'] = [
      {
        getConfig: () => ({
          options: { subject: 'Your invite' },
          getEmailContent: (path: string) => ({ text: `Accept: /${path}`, html: `<a href="/${path}">Accept</a>` }),
        }),
      },
    ];
    cache['@proteinjs/email-server/DefaultSignupConfirmationEmailConfigFactory'] = [
      { getConfig: () => ({ getNewUserEmailContent: () => ({ text: 'welcome', html: '<p>welcome</p>' }) }) },
    ];
    // Invite-optional, the library default — the suites load src, never the generated source graph.
    cache['@proteinjs/user-server/DefaultInviteConfigFactory'] = [{ getConfig: () => ({ isInviteOnly: false }) }];
    cache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
    cache['@proteinjs/user/RoleCatalogEntry'] = [new OpsRole()];
    cache['@proteinjs/db/TableWatcher'] = [new UserStatusTableWatcher()];
    resetTableWatcherMap();
  }, 120000);

  afterAll(async () => {
    const cache = objectCache();
    for (const key of [
      '@proteinjs/email-server/DefaultEmailConfigFactory',
      '@proteinjs/email-server/DefaultPasswordResetEmailConfigFactory',
      '@proteinjs/email-server/DefaultInviteEmailConfigFactory',
      '@proteinjs/email-server/DefaultSignupConfirmationEmailConfigFactory',
      '@proteinjs/user-server/DefaultInviteConfigFactory',
      '@proteinjs/user-auth/AuthenticatedUserRepo',
      '@proteinjs/user/RoleCatalogEntry',
      '@proteinjs/db/TableWatcher',
      '@proteinjs/db/SourceRecordLoader',
    ]) {
      delete cache[key];
    }
    delete namedObjectCache()['@proteinjs/db/SourceRecordLoader'];
    resetTableWatcherMap();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await testEnv.afterAll();
  });

  beforeEach(() => {
    MailSink.get().clear();
  });

  it('the reset door: an unknown address, a mailed link, a repeat inside five minutes, a failed send', async () => {
    await testEnv.createUser({ name: 'Reset Mailed', email: 'reset-mailed@test.local' });
    await testEnv.createUser({ name: 'Reset Fails', email: 'reset-fails@test.local' });

    const log = await LogCapture.during(async () => {
      await invoke(initiatePasswordReset, { body: { email: 'reset-nobody@test.local' } });
      await invoke(initiatePasswordReset, { body: { email: 'Reset-Mailed@test.local' } });
      await invoke(initiatePasswordReset, { body: { email: 'reset-mailed@test.local' } });
      const failing = jest
        .spyOn(EmailSender.prototype, 'sendEmail')
        .mockRejectedValueOnce(new Error('Failed to send email'));
      try {
        await invoke(initiatePasswordReset, { body: { email: 'reset-fails@test.local' } });
      } finally {
        failing.mockRestore();
      }
    });

    expect(MailSink.get().list()).toHaveLength(1);
    expect(log.addresses).toEqual([]);
    for (const address of ['reset-nobody@test.local', 'reset-mailed@test.local', 'reset-fails@test.local']) {
      expect(log.text).toContain(digests.account(address));
    }
  });

  it('the reset link: redeemed, presented again, expired, and an expired link validated', async () => {
    const redeemer = await testEnv.createUser({ name: 'Reset Redeemer', email: 'reset-redeem@test.local' });
    const token = await new PasswordResetToken().mint(redeemer);
    const lapsed = await testEnv.createUser({ name: 'Reset Lapsed', email: 'reset-lapsed@test.local' });
    const lapsedToken = await new PasswordResetToken().mint(lapsed);
    await getDbAsSystem().update(tables.User, {
      id: lapsed.id,
      passwordResetTokenExpiration: moment().subtract(1, 'hour'),
    });

    const log = await LogCapture.during(async () => {
      expect((await invoke(executePasswordReset, { body: { token, newPassword: 'fresh-password' } })).status).toBe(200);
      expect((await invoke(executePasswordReset, { body: { token, newPassword: 'again-password' } })).status).toBe(400);
      expect(
        (await invoke(executePasswordReset, { body: { token: lapsedToken, newPassword: 'late-password' } })).status
      ).toBe(400);
      expect((await invoke(validateResetPasswordToken, { query: { token: lapsedToken } })).body.isValid).toBe(false);
    });

    expect(log.addresses).toEqual([]);
    expect(log.text).toContain(digests.account('reset-redeem@test.local'));
    expect(log.text).toContain(digests.account('reset-lapsed@test.local'));
  });

  it('an invite: sent, re-sent, a send that fails, a re-send that fails — the invitee by its address digest', async () => {
    const inviter = await testEnv.createUser({ name: 'Inviter', email: 'logs-inviter@test.local', roles: ['admin'] });
    testEnv.actAs(inviter);

    const log = await LogCapture.during(async () => {
      expect(await new Signup().sendInvite('Invitee@Example.invalid')).toEqual({ sent: true });
      expect(await new Signup().resendInvite('invitee@example.invalid')).toEqual({ sent: true });
      const failing = jest
        .spyOn(EmailSender.prototype, 'sendEmail')
        .mockRejectedValue(new Error('Failed to send email'));
      try {
        expect((await new Signup().sendInvite('invitee-fails@example.invalid')).sent).toBe(false);
        expect((await new Signup().resendInvite('invitee@example.invalid')).sent).toBe(false);
      } finally {
        failing.mockRestore();
      }
    });

    expect(MailSink.get().list()).toHaveLength(2);
    expect(log.addresses).toEqual([]);
    expect(log.text).toContain(digests.address('invitee-fails@example.invalid'));
    expect(log.text).toContain(digests.address('invitee@example.invalid'));
  });

  it('signup: an account created, then the same address again', async () => {
    const log = await LogCapture.during(async () => {
      const user = { name: 'Signer', email: 'Logs-Signup@test.local', password: 'a-password' };
      expect((await new Signup().createUser(user)).outcome).toBe('created');
      expect((await new Signup().createUser(user)).outcome).toBe('exists');
    });

    expect(log.addresses).toEqual([]);
    expect(log.text).toContain(digests.account('logs-signup@test.local'));
  });

  it('sign-in and sessions: a deactivated account refused, a session on a deactivated account, a session on a missing account', async () => {
    await getDbAsSystem().insert(tables.User, {
      name: 'Deactivated',
      email: 'logs-deactivated@test.local',
      password: sha256('correct-password').toString(),
      emailVerified: true,
      roles: [],
      status: 'deactivated',
    });

    const log = await LogCapture.during(async () => {
      expect(await authenticate('Logs-Deactivated@test.local', 'correct-password')).toBe(
        'This account has been deactivated'
      );
      expect((await userCache.create('logs-session-1', 'logs-deactivated@test.local')).id).toBe('guest');
      expect((await userCache.create('logs-session-2', 'logs-missing@test.local')).id).toBe('guest');
    });

    expect(log.addresses).toEqual([]);
    expect(log.text).toContain(digests.account('logs-deactivated@test.local'));
    expect(log.text).toContain(digests.account('logs-missing@test.local'));
  });

  it('the sessions a deactivation kills, and a minted machine credential', async () => {
    const human = await testEnv.createUser({ name: 'Soon Deactivated', email: 'logs-kill@test.local' });
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await getDbAsSystem().insert(tables.Session, {
      sessionId: 'logs-kill',
      session: '{}',
      expires,
      userEmail: human.email,
    });
    const declarations = [new LogsMachineAccount()];
    objectCache()['@proteinjs/db/SourceRecordLoader'] = declarations;
    namedObjectCache()['@proteinjs/db/SourceRecordLoader'] = declarations.map((object) => ({
      qualifiedName: '@proteinjs/user-server-test/LogsMachineAccount',
      packageName: '@proteinjs/user-server',
      object,
    }));
    await new SourceRecordSyncRunner().load();

    const log = await LogCapture.during(async () => {
      await getDbAsSystem().update(tables.User, { id: human.id, status: 'deactivated' });
      expect((await new MachineCredentials().mintCredential('machine-logs@test.local')).secretName).toBe(
        'logs-ops-secret'
      );
    });

    expect(await getDbAsSystem().query(tables.Session, { sessionId: 'logs-kill' })).toEqual([]);
    expect(log.addresses).toEqual([]);
    expect(log.text).toContain(digests.account('logs-kill@test.local'));
    expect(log.text).toContain(digests.account('machine-logs@test.local'));
  });

  it('the dev doors: a missing test account created, the first-admin grant, a session established', async () => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = 'logs-dev@test.local';
    process.env.DEV_BOOTSTRAP_ADMIN_EMAIL = 'logs-dev@test.local';
    delete process.env.DEV_BOOTSTRAP_ROLES;
    // The first-admin door grants only while no account holds admin.
    const admins = await getDbAsSystem().query(tables.User, {});
    for (const admin of admins.filter((user) => (user.roles ?? []).includes('admin'))) {
      await getDbAsSystem().update(tables.User, { id: admin.id, roles: [] });
    }

    const log = await LogCapture.during(async () => {
      expect((await invokeDevLogin()).loggedInAs).toBe('logs-dev@test.local');
    });

    expect(log.text).toContain('Dev bootstrap admin door: granted');
    expect(log.addresses).toEqual([]);
    expect(log.text).toContain(digests.account('logs-dev@test.local'));
  });
});
