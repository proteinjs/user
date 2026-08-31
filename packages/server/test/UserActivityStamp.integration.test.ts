import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables, type User, type UserActivity } from '@proteinjs/user';
import { userCache } from '../src/authorization/userCache';
import { UserActivityStamp } from '../src/authorization/UserActivityStamp';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type StampInternals = {
  constructor: { lastStampMs: Map<string, number>; STAMP_INTERVAL_MS: number };
};

const stampInternals = (stamp: UserActivityStamp) => (stamp as unknown as StampInternals).constructor;

const activityRows = async (scope: string): Promise<UserActivity[]> =>
  await getDbAsSystem().query(tables.UserActivity, { scope });

/** The stamp write is fire-and-forget off userCache — poll the OUTCOME (row present) briefly. */
const waitForActivityRow = async (scope: string): Promise<UserActivity> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await activityRows(scope);
    if (rows.length > 0) {
      return rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No user_activity row appeared for scope ${scope}`);
};

/**
 * LAST ACTIVITY = HUMAN PRESENCE (UserActivityTable's contract): the stamp fires from
 * userCache.create — the once-per-interactive-request session-cache build — and from nowhere
 * else. These tests pin the seam's outcomes: a human's request lands the presence row; machine
 * accounts (real sessions, e.g. the error bridge's polling login) never do; repeated stamps
 * keep ONE row per user; the throttle holds writes to the interval.
 */
describe('UserActivityStamp — interactive presence', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(() => {
    // Each test controls its own throttle history.
    stampInternals(new UserActivityStamp()).lastStampMs.clear();
  });

  it('stamps presence when a signed-in human makes an interactive request (through userCache.create)', async () => {
    const user = await testEnv.createUser({ name: 'Present Human', email: 'present-human@test.local' });

    const resolved = await userCache.create('interactive-session', user.email);
    expect(resolved.id).toBe(user.id);

    const row = await waitForActivityRow(user.id);
    expect(moment(row.lastActiveAt).isAfter(moment().subtract(1, 'minute'))).toBe(true);
  });

  it('keeps ONE row per user and advances it on later stamps (scope-unique invariant)', async () => {
    const user = await testEnv.createUser({ name: 'Returning Human', email: 'returning-human@test.local' });
    const stamp = new UserActivityStamp();

    await stamp.recordInteractiveRequest(user);
    const first = await waitForActivityRow(user.id);

    // Clear the throttle so the second request stamps immediately.
    stampInternals(stamp).lastStampMs.clear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stamp.recordInteractiveRequest(user);

    const rows = await activityRows(user.id);
    expect(rows).toHaveLength(1);
    expect(moment(rows[0].lastActiveAt).valueOf()).toBeGreaterThanOrEqual(moment(first.lastActiveAt).valueOf());
  });

  it('never stamps a machine account, even though its requests ride a real session', async () => {
    const machine = await getDbAsSystem().insert(tables.User, {
      name: 'Ops machine',
      email: 'stamp-machine@test.local',
      password: 'test',
      emailVerified: true,
      roles: [],
      isLoadedFromSource: true,
    } as unknown as User);

    // Await the stamp DIRECTLY (deterministic absence — no fire-and-forget race), then confirm
    // the transport seam agrees by resolving the machine session through userCache too.
    await new UserActivityStamp().recordInteractiveRequest(machine);
    const resolved = await userCache.create('machine-session', machine.email);
    expect(resolved.id).toBe(machine.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await activityRows(machine.id)).toHaveLength(0);
  });

  it('throttles: a second request inside the interval writes nothing', async () => {
    const user = await testEnv.createUser({ name: 'Rapid Human', email: 'rapid-human@test.local' });
    const stamp = new UserActivityStamp();

    await stamp.recordInteractiveRequest(user);
    const first = await waitForActivityRow(user.id);

    // Throttle history now holds this user; a second stamp inside the interval must not write.
    await stamp.recordInteractiveRequest(user);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const rows = await activityRows(user.id);
    expect(rows).toHaveLength(1);
    expect(moment(rows[0].lastActiveAt).valueOf()).toBe(moment(first.lastActiveAt).valueOf());
  });

  it('a session for a missing account still resolves guest and stamps nothing (no throw)', async () => {
    const before = (await getDbAsSystem().query(tables.UserActivity, {})).length;
    const resolved = await userCache.create('stale-session', 'no-such-account@test.local');
    expect(resolved.id).toBe('guest');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await getDbAsSystem().query(tables.UserActivity, {})).length).toBe(before);
  });
});
