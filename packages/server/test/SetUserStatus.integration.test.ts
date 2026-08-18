import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
// Deep import (test-only): ServiceAuth is the real RPC door but is not index-exported by
// @proteinjs/service — the door test below runs the actual gate rather than pinning metadata.
import { ServiceAuth } from '@proteinjs/service/dist/src/ServiceAuth';
import { User, UserRepo, tables } from '@proteinjs/user';
import { SetUserStatus } from '../src/services/SetUserStatus';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

/**
 * The SetUserStatus service is the ONE write path for account standing: the status update and
 * its `user_status_event` audit row commit together. Outcomes asserted against the emulator:
 * the rows written, not the calls made.
 *
 * The service door is exercised through ServiceAuth itself (the same gate the RPC path runs):
 * the explicit `roles: ['admin']` block refuses everyone but admins.
 */
describe('SetUserStatus service — admin door, standing writes, audit trail', () => {
  let admin: User;
  let nonAdmin: User;
  let target: User;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // ServiceAuth funnels through UserAuth, which resolves the current user from the
    // source-graph-registered AuthenticatedUserRepo — seed it the way the env seeds session
    // storage (tests do not load the generated source graph).
    (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache[
      '@proteinjs/user-auth/AuthenticatedUserRepo'
    ] = [new UserRepo()];
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    const db = getDbAsSystem();
    await db.delete(tables.UserStatusEvent, {});
    await db.delete(tables.User, {});
    admin = await testEnv.createUser({ name: 'Admin actor', email: 'status-admin@test.local', roles: ['admin'] });
    nonAdmin = await testEnv.createUser({ name: 'Plain actor', email: 'status-plain@test.local', roles: ['ops'] });
    target = await testEnv.createUser({ name: 'Target user', email: 'status-target@test.local' });
  });

  const targetStatus = async () => (await getDbAsSystem().get(tables.User, { id: target.id }))!.status;
  const auditRows = async () => await getDbAsSystem().query(tables.UserStatusEvent, {});
  const canRun = () =>
    ServiceAuth.canRunService(new SetUserStatus(), { name: 'setUserStatus' } as any, [target.id, 'deactivated']);

  it('refuses the door for a non-admin and admits an admin', () => {
    testEnv.actAs(nonAdmin);
    expect(canRun()).toBe(false);

    testEnv.actAs(admin);
    expect(canRun()).toBe(true);
  });

  it('deactivate writes the standing on the user row and one audit row', async () => {
    testEnv.actAs(admin);
    await new SetUserStatus().setUserStatus(target.id, 'deactivated');

    expect(await targetStatus()).toBe('deactivated');
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: admin.id, target: target.id, status: 'deactivated' });
    expect(events[0].created).toBeDefined();
  });

  it('setting the standing the user already holds changes nothing and writes no audit row', async () => {
    testEnv.actAs(admin);
    const service = new SetUserStatus();
    await service.setUserStatus(target.id, 'deactivated');
    await service.setUserStatus(target.id, 'deactivated');

    expect(await targetStatus()).toBe('deactivated');
    expect(await auditRows()).toHaveLength(1);
  });

  it('treats a null standing (row predating the column) as active — no write, no audit row', async () => {
    await getDbAsSystem().update(tables.User, { id: target.id, status: null });

    testEnv.actAs(admin);
    await new SetUserStatus().setUserStatus(target.id, 'active');

    expect(await targetStatus()).toBeFalsy();
    expect(await auditRows()).toHaveLength(0);
  });

  it('reactivate flips the standing back and audits it', async () => {
    testEnv.actAs(admin);
    const service = new SetUserStatus();
    await service.setUserStatus(target.id, 'deactivated');
    await service.setUserStatus(target.id, 'active');

    expect(await targetStatus()).toBe('active');
    const events = await auditRows();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.status).sort()).toEqual(['active', 'deactivated']);
  });

  it('refuses a standing the vocabulary does not know, and writes nothing', async () => {
    testEnv.actAs(admin);
    await expect(new SetUserStatus().setUserStatus(target.id, 'suspended' as any)).rejects.toThrow(
      `'suspended' is not a known user status. Pick one of: active, deactivated.`
    );
    expect(await targetStatus()).toBe('active');
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a change for a user that does not exist', async () => {
    testEnv.actAs(admin);
    await expect(new SetUserStatus().setUserStatus('nobody-1', 'deactivated')).rejects.toThrow(
      'No user found for id: nobody-1'
    );
    expect(await auditRows()).toHaveLength(0);
  });
});
