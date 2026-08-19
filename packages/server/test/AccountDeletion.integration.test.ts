import sha256 from 'crypto-js/sha256';
import moment from 'moment';
import { Reference, getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
// Deep import (test-only): ServiceAuth is the real RPC door but is not index-exported by
// @proteinjs/service — the door test below runs the actual gate rather than pinning metadata.
import { ServiceAuth } from '@proteinjs/service/dist/src/ServiceAuth';
import { AccessGrant, ManifestGrant, User, UserRepo, guestUser, tables } from '@proteinjs/user';
import { AccountDeletion } from '../src/services/AccountDeletion';
import { authenticate } from '../src/authentication/authenticate';
import { login } from '../src/routes/login';
import { createPassportRequest } from './passportSessionHarness';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const PASSWORD_A = 'alpha-password';
const PASSWORD_B = 'beta-password';
const RESOURCE_TABLE = 'file';

/**
 * BUILD §9.1 — the deactivation + cancel suite, two users, outcomes only (rows written against
 * the emulator, never calls made). Fixture: A owns r1/r2 (shared outbound to B), B owns r3
 * (shared inbound to A). A's deletion must revoke both directions while B's own grant — and
 * A's owner grants, the purge walker's terminal targets — survive.
 */
describe('AccountDeletion — deactivation, manifest, resume, cancel-by-login', () => {
  let userA: User;
  let userB: User;
  const r1 = 'resource-a-one';
  const r2 = 'resource-a-two';
  const r3 = 'resource-b-three';
  let ownerA1: AccessGrant;
  let ownerA2: AccessGrant;
  let outbound1: AccessGrant;
  let outbound2: AccessGrant;
  let inbound: AccessGrant;
  let ownerB: AccessGrant;

  beforeAll(async () => {
    await testEnv.beforeAll();
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.AccountDeletion, {});
    await db.delete(tables.AccessGrant, {});
    await db.delete(tables.Session, {});
    await db.delete(tables.UserStatusEvent, {});
    await db.delete(tables.User, {});

    userA = await createAccount('deleter@test.local', PASSWORD_A);
    userB = await createAccount('keeper@test.local', PASSWORD_B);

    ownerA1 = await insertGrant(userA.id, r1, 'owner');
    ownerA2 = await insertGrant(userA.id, r2, 'owner');
    outbound1 = await insertGrant(userB.id, r1, 'read');
    outbound2 = await insertGrant(userB.id, r2, 'write');
    ownerB = await insertGrant(userB.id, r3, 'owner');
    inbound = await insertGrant(userA.id, r3, 'read');

    await insertSession('session-a-1', userA.email);
    await insertSession('session-a-2', userA.email);
    await insertSession('session-b-1', userB.email);
  });

  /** Insert an account the way the product stores it: lowercased email, sha256 password. */
  const createAccount = async (email: string, password: string) => {
    return await getDbAsSystem().insert(tables.User, {
      name: 'Deletion test user',
      email,
      password: sha256(password).toString(),
      emailVerified: true,
      roles: [],
    });
  };

  const insertGrant = async (principalId: string, resourceId: string, accessLevel: AccessGrant['accessLevel']) => {
    return await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference(tables.User.name, principalId),
      resource: new Reference(RESOURCE_TABLE, resourceId),
      resourceTable: RESOURCE_TABLE,
      accessLevel,
    });
  };

  const insertSession = async (sessionId: string, userEmail: string) => {
    return await getDbAsSystem().insert(tables.Session, {
      sessionId,
      session: '{}',
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      userEmail,
    });
  };

  const grantRows = async () => await getDbAsSystem().query(tables.AccessGrant, {});
  const sessionRows = async () => await getDbAsSystem().query(tables.Session, {});
  const auditRows = async () => await getDbAsSystem().query(tables.UserStatusEvent, {});
  const deletionRow = async (userId: string) => await getDbAsSystem().get(tables.AccountDeletion, { userId });
  const userRow = async (id: string) => await getDbAsSystem().get(tables.User, { id });

  const sortById = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

  const expectedManifest = (): ManifestGrant[] => [
    { id: inbound.id, principal: userA.id, resource: r3, resourceTable: RESOURCE_TABLE, accessLevel: 'read' },
    { id: outbound1.id, principal: userB.id, resource: r1, resourceTable: RESOURCE_TABLE, accessLevel: 'read' },
    { id: outbound2.id, principal: userB.id, resource: r2, resourceTable: RESOURCE_TABLE, accessLevel: 'write' },
  ];

  /**
   * Drive the real login route over REAL passport login machinery (passportSessionHarness):
   * establishSession regenerates the id (fixation) and commits the session row before the route
   * responds — both live inside passport's `request.login` now; ordering is pinned by
   * SignupRoute.test.ts.
   */
  const invokeLogin = async (email: string, password: string) => {
    let sent: any;
    const response: any = {
      send: (body: any) => {
        sent = body;
      },
      status: () => response,
    };
    const { request, events } = await createPassportRequest({ body: { email, password } });
    await login.onRequest(request, response);
    return {
      loggedInAs: request.session.passport?.user as string | undefined,
      regenerated: events.includes('regenerate'),
      sent,
    };
  };

  it('the service door admits any signed-in account and refuses guests', () => {
    // ServiceAuth funnels through UserAuth, which resolves the current user from the
    // source-graph-registered AuthenticatedUserRepo — seed it the way the env seeds session
    // storage (tests do not load the generated source graph).
    (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache[
      '@proteinjs/user-auth/AuthenticatedUserRepo'
    ] = [new UserRepo()];
    const canRun = () =>
      ServiceAuth.canRunService(new AccountDeletion(), { name: 'requestDeletion' } as any, [PASSWORD_A]);

    testEnv.actAs(userA); // a plain account with no roles at all
    expect(canRun()).toBe(true);

    testEnv.actAs(guestUser as User);
    expect(canRun()).toBe(false);
  });

  it('deactivates: revokes grants both directions, persists the full manifest, flips + audits standing, kills sessions', async () => {
    testEnv.actAs(userA);
    const result = await new AccountDeletion().requestDeletion(PASSWORD_A);

    // Grants: outbound (B on r1/r2) and inbound (A on r3) revoked; A's owner grants (the purge
    // walker's terminal targets) and B's own owner grant survive.
    const remaining = await grantRows();
    expect(sortById(remaining).map((grant) => grant.id)).toEqual(
      sortById([ownerA1, ownerA2, ownerB]).map((grant) => grant.id)
    );

    // Manifest row: full grant set both directions, owned-resource snapshot, grace phase.
    const deletion = await deletionRow(userA.id);
    expect(deletion).toBeTruthy();
    expect(deletion.phase).toBe('grace');
    expect(deletion.leaseSeq).toBe(0);
    expect(deletion.userEmail).toBe(userA.email);
    expect([...deletion.ownedResourceIds].sort()).toEqual([r1, r2].sort());
    expect(sortById(deletion.manifestGrants)).toEqual(sortById(expectedManifest()));

    // purgeAfter ≈ now + 30 days, and the service returned the same stamp.
    const hoursOut = moment(deletion.purgeAfter).diff(moment(), 'hours', true);
    expect(hoursOut).toBeGreaterThan(719);
    expect(hoursOut).toBeLessThan(721);
    expect(Math.abs(result.purgeAfter.valueOf() - moment(deletion.purgeAfter).valueOf())).toBeLessThan(1000);

    // User row: audited flip + deletion stamps.
    const flipped = await userRow(userA.id);
    expect(flipped.status).toBe('deactivated');
    expect(flipped.deleteRequestedAt).toBeTruthy();
    expect(Math.abs(moment(flipped.purgeAfter).valueOf() - moment(deletion.purgeAfter).valueOf())).toBeLessThan(1000);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: userA.id, target: userA.id, status: 'deactivated' });

    // Sessions: A's two killed, B's untouched.
    const sessions = await sessionRows();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userEmail).toBe(userB.email);
  });

  it('refuses a wrong password with zero writes', async () => {
    testEnv.actAs(userA);
    await expect(new AccountDeletion().requestDeletion('wrong-password')).rejects.toThrow('Password incorrect');

    expect(await deletionRow(userA.id)).toBeFalsy();
    expect(await grantRows()).toHaveLength(6);
    expect(await sessionRows()).toHaveLength(3);
    expect(await auditRows()).toHaveLength(0);
    const untouched = await userRow(userA.id);
    expect(untouched.status).toBe('active');
    expect(untouched.deleteRequestedAt).toBeFalsy();
    expect(untouched.purgeAfter).toBeFalsy();
  });

  it('resume keeps the FULL manifest after a crash mid-revocation — never re-enumerates', async () => {
    testEnv.actAs(userA);
    const service = new AccountDeletion();
    await service.requestDeletion(PASSWORD_A);
    const persisted = await deletionRow(userA.id);
    expect(persisted.manifestGrants).toHaveLength(3);

    // Simulate the §3.3 crash window (mid step 4): two of the revoked grants were never actually
    // deleted — restore them with their ORIGINAL ids — and the user row/sessions never flipped.
    for (const grant of [outbound1, outbound2]) {
      await getDbAsSystem().insert(tables.AccessGrant, {
        id: grant.id,
        principal: new Reference(tables.User.name, grant.principal._id as string),
        resource: new Reference(RESOURCE_TABLE, grant.resource._id as string),
        resourceTable: RESOURCE_TABLE,
        accessLevel: grant.accessLevel,
      } as any);
    }
    await getDbAsSystem().update(tables.User, {
      id: userA.id,
      status: 'active',
      deleteRequestedAt: null,
      purgeAfter: null,
    });
    await insertSession('session-a-3', userA.email);

    // The user's retry resumes from the stored manifest.
    await service.requestDeletion(PASSWORD_A);

    // THE red assertion: the manifest still holds the FULL pre-crash set. A re-enumerating
    // implementation rebuilds it from the shrunken live grants (the inbound grant is already
    // gone) and this fails.
    const resumed = await deletionRow(userA.id);
    expect(sortById(resumed.manifestGrants)).toEqual(sortById(expectedManifest()));
    expect([...resumed.ownedResourceIds].sort()).toEqual([r1, r2].sort());

    // And the resume completed the crashed pass: revocation drained, standing flipped, session dead.
    const remaining = await grantRows();
    expect(sortById(remaining).map((grant) => grant.id)).toEqual(
      sortById([ownerA1, ownerA2, ownerB]).map((grant) => grant.id)
    );
    expect((await userRow(userA.id)).status).toBe('deactivated');
    expect((await sessionRows()).map((session) => session.userEmail)).toEqual([userB.email]);
  });

  it('cancel restores grants (fresh ids), reactivates + audits, nulls stamps, deletes the manifest row', async () => {
    testEnv.actAs(userA);
    await new AccountDeletion().requestDeletion(PASSWORD_A);
    const manifest = (await deletionRow(userA.id)).manifestGrants;

    const outcome = await new AccountDeletion().cancelPendingDeletion(userA.email);
    expect(outcome).toBe('restored');

    // Every revoked grant is back — matched by (principal, resource, accessLevel), with a FRESH id.
    const all = await grantRows();
    expect(all).toHaveLength(6);
    for (const entry of manifest) {
      const matches = all.filter(
        (grant) =>
          grant.principal._id === entry.principal &&
          grant.resource._id === entry.resource &&
          grant.accessLevel === entry.accessLevel
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].id).not.toBe(entry.id);
    }

    // User row: active again through the audited path, stamps nulled.
    const restored = await userRow(userA.id);
    expect(restored.status).toBe('active');
    expect(restored.deleteRequestedAt).toBeFalsy();
    expect(restored.purgeAfter).toBeFalsy();
    const events = await auditRows();
    expect(events.map((event) => event.status).sort()).toEqual(['active', 'deactivated']);

    expect(await deletionRow(userA.id)).toBeFalsy();
  });

  it('cancel resumes a crashed prior cancel: restoring-phase re-entry, no duplicate grants', async () => {
    testEnv.actAs(userA);
    await new AccountDeletion().requestDeletion(PASSWORD_A);
    const deletion = await deletionRow(userA.id);

    // A prior cancel claimed the row, restored ONE grant, then crashed.
    await getDbAsSystem().update(tables.AccountDeletion, { id: deletion.id, phase: 'restoring' });
    const first = deletion.manifestGrants[0];
    await getDbAsSystem().insert(tables.AccessGrant, {
      principal: new Reference(tables.User.name, first.principal),
      resource: new Reference(first.resourceTable as string, first.resource),
      resourceTable: first.resourceTable,
      accessLevel: first.accessLevel,
    });

    const outcome = await new AccountDeletion().cancelPendingDeletion(userA.email);
    expect(outcome).toBe('restored');

    // Idempotent re-insert: exactly one grant per manifest entry — no duplicates.
    const all = await grantRows();
    expect(all).toHaveLength(6);
    for (const entry of deletion.manifestGrants) {
      const matches = all.filter(
        (grant) =>
          grant.principal._id === entry.principal &&
          grant.resource._id === entry.resource &&
          grant.accessLevel === entry.accessLevel
      );
      expect(matches).toHaveLength(1);
    }
    expect((await userRow(userA.id)).status).toBe('active');
    expect(await deletionRow(userA.id)).toBeFalsy();
  });

  it('cancel refuses once the purge walker has claimed the row', async () => {
    testEnv.actAs(userA);
    await new AccountDeletion().requestDeletion(PASSWORD_A);
    const deletion = await deletionRow(userA.id);
    await getDbAsSystem().update(tables.AccountDeletion, { id: deletion.id, phase: 'purging' });

    const outcome = await new AccountDeletion().cancelPendingDeletion(userA.email);
    expect(outcome).toBe('purging');

    // Nothing restored: standing stays deactivated, grants stay revoked, manifest row stays.
    expect((await userRow(userA.id)).status).toBe('deactivated');
    expect(await grantRows()).toHaveLength(3);
    expect((await deletionRow(userA.id)).phase).toBe('purging');
  });

  it('cancel is a no-op for an account with no pending deletion', async () => {
    expect(await new AccountDeletion().cancelPendingDeletion(userB.email)).toBe('not-pending');
    expect(await grantRows()).toHaveLength(6);
  });

  it('authenticate matrix: active, staff-deactivated, pending-deletion, mid-purge', async () => {
    // Active + correct credentials.
    expect(await authenticate(userB.email, PASSWORD_B)).toBe(true);

    // Staff deactivation (no deleteRequestedAt) stays refused.
    await getDbAsSystem().update(tables.User, { id: userB.id, status: 'deactivated' });
    expect(await authenticate(userB.email, PASSWORD_B)).toBe('This account has been deactivated');

    // Pending deletion: credentials valid — the login route decides (cancel hook).
    testEnv.actAs(userA);
    await new AccountDeletion().requestDeletion(PASSWORD_A);
    expect(await authenticate(userA.email, PASSWORD_A)).toBe(true);

    // Mid-purge: still credentials-valid here; the route's cancel hook returns the refusal.
    const deletion = await deletionRow(userA.id);
    await getDbAsSystem().update(tables.AccountDeletion, { id: deletion.id, phase: 'purging' });
    expect(await authenticate(userA.email, PASSWORD_A)).toBe(true);
  });

  it('cancel-by-login: logging back in during grace restores the account before the session starts', async () => {
    testEnv.actAs(userA);
    await new AccountDeletion().requestDeletion(PASSWORD_A);

    const { loggedInAs, regenerated, sent } = await invokeLogin(userA.email, PASSWORD_A);

    expect(sent).toEqual({});
    expect(loggedInAs).toBe(userA.email);
    expect(regenerated).toBe(true); // the login door inherits fresh-id-on-privilege-change
    expect((await userRow(userA.id)).status).toBe('active');
    expect(await grantRows()).toHaveLength(6);
    expect(await deletionRow(userA.id)).toBeFalsy();
  });

  it('login refuses a mid-purge account with the no-longer-restorable message', async () => {
    testEnv.actAs(userA);
    await new AccountDeletion().requestDeletion(PASSWORD_A);
    const deletion = await deletionRow(userA.id);
    await getDbAsSystem().update(tables.AccountDeletion, { id: deletion.id, phase: 'purging' });

    const { loggedInAs, sent } = await invokeLogin(userA.email, PASSWORD_A);

    expect(sent).toEqual({ error: 'This account is being deleted and can no longer be restored.' });
    expect(loggedInAs).toBeUndefined();
    expect((await userRow(userA.id)).status).toBe('deactivated');
  });

  it('login refuses a staff-deactivated account outright', async () => {
    await getDbAsSystem().update(tables.User, { id: userB.id, status: 'deactivated' });

    const { loggedInAs, sent } = await invokeLogin(userB.email, PASSWORD_B);

    expect(sent).toEqual({ error: 'This account has been deactivated' });
    expect(loggedInAs).toBeUndefined();
  });
});
