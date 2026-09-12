import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { guestUser, tables, type User, type UserActivity } from '@proteinjs/user';
import { UserActivityStamp } from '../src/authorization/UserActivityStamp';
import { UserPresence } from '../src/services/UserPresence';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

type StampInternals = {
  constructor: { lastStampMs: Map<string, number>; STAMP_INTERVAL_MS: number };
};

const stampInternals = (stamp: UserActivityStamp) => (stamp as unknown as StampInternals).constructor;

const activityRows = async (scope: string): Promise<UserActivity[]> =>
  await getDbAsSystem().query(tables.UserActivity, { scope });

/**
 * LAST ACTIVITY = HUMAN PRESENCE (UserActivityTable's contract): the stamp is written from the
 * page's human-input report — the UserPresence service door — and from nowhere else (the
 * session build's non-stamp is pinned in UserCacheDoesNotStampPresence). These tests pin the
 * door's outcomes: a person's report lands the presence row for the CALLING user; machine
 * accounts and the guest identity never do; repeated reports keep ONE row per user; the
 * throttle holds writes to the interval.
 */
describe('UserActivityStamp — human-input presence', () => {
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

  it('the presence door stamps the calling user: a page report under her session lands her row', async () => {
    const user = await testEnv.createUser({ name: 'Present Human', email: 'present-human@test.local' });
    testEnv.actAs(user);

    await new UserPresence().recordPresence();

    const rows = await activityRows(user.id);
    expect(rows).toHaveLength(1);
    expect(moment(rows[0].lastActiveAt).isAfter(moment().subtract(1, 'minute'))).toBe(true);
  });

  it('keeps ONE row per user and advances it on later reports (scope-unique invariant)', async () => {
    const user = await testEnv.createUser({ name: 'Returning Human', email: 'returning-human@test.local' });
    const stamp = new UserActivityStamp();

    await stamp.recordHumanInput(user);
    const [first] = await activityRows(user.id);
    expect(first).toBeDefined();

    // Clear the throttle so the second report stamps immediately.
    stampInternals(stamp).lastStampMs.clear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stamp.recordHumanInput(user);

    const rows = await activityRows(user.id);
    expect(rows).toHaveLength(1);
    expect(moment(rows[0].lastActiveAt).valueOf()).toBeGreaterThanOrEqual(moment(first.lastActiveAt).valueOf());
  });

  it('never stamps a machine account (`machine` — the one owner of "is this a machine"), even through the door', async () => {
    const machine = await getDbAsSystem().insert(tables.User, {
      name: 'Ops machine',
      email: 'stamp-machine@test.local',
      password: 'test',
      emailVerified: true,
      roles: [],
      isLoadedFromSource: true,
      machine: true,
    } as unknown as User);

    await new UserActivityStamp().recordHumanInput(machine);
    testEnv.actAs(machine);
    await new UserPresence().recordPresence();

    expect(await activityRows(machine.id)).toHaveLength(0);
  });

  it('never stamps the guest identity (a door reached with no signed-in user)', async () => {
    const before = (await getDbAsSystem().query(tables.UserActivity, {})).length;
    await new UserActivityStamp().recordHumanInput(guestUser);
    expect((await getDbAsSystem().query(tables.UserActivity, {})).length).toBe(before);
  });

  it('throttles: a second report inside the interval writes nothing', async () => {
    const user = await testEnv.createUser({ name: 'Rapid Human', email: 'rapid-human@test.local' });
    const stamp = new UserActivityStamp();

    await stamp.recordHumanInput(user);
    const [first] = await activityRows(user.id);
    expect(first).toBeDefined();

    // Throttle history now holds this user; a second report inside the interval must not write.
    await stamp.recordHumanInput(user);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const rows = await activityRows(user.id);
    expect(rows).toHaveLength(1);
    expect(moment(rows[0].lastActiveAt).valueOf()).toBe(moment(first.lastActiveAt).valueOf());
  });
});
