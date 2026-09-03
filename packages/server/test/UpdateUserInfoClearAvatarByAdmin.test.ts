import sharp from 'sharp';
import { getDbAsSystem } from '@proteinjs/db';
import { File, tables as fileTables } from '@proteinjs/db-file';
import { SourceRepository } from '@proteinjs/reflection';
import { tables, UpdateUserInfoService, User, UserRepo, getScopedDbAsSystem } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';

const testEnv = new UserServerTestEnvironment();

const getFileRow = async (fileId: string) => await getScopedDbAsSystem<File>().get(fileTables.File, { id: fileId });
const userRow = async (id: string) => await getDbAsSystem().get(tables.User, { id });

/**
 * Clearing SOMEONE ELSE'S avatar — the user-manager act behind the admin user surface.
 *
 * The service door is `allUsers` (every signed-in user manages their own profile through it), so
 * the cross-user authorization is in-body and fail-closed: naming another person's id requires
 * the `users` permission. Two invariants beyond the row write:
 *  - the ACTOR's session cache is never overwritten with the target's row (the mutation path
 *    refreshes the caller's cached user, and doing that for another person's row would leave the
 *    admin browsing as their target);
 *  - the target's own session cache is NOT refreshed — the write is to their row, and their next
 *    sign-in reads it.
 * Outcomes asserted against a real Spanner emulator: rows, files, cached identity.
 */
describe('UpdateUserInfo — clearing another person avatar', () => {
  const service: UpdateUserInfoService = new UpdateUserInfo();
  let admin: User;
  let kevin: User;

  beforeAll(async () => {
    await testEnv.beforeAll();
    // The in-body permission check resolves the CALLER through UserAuth — the same session-backed
    // repo the services use (the environment seeds session storage but not this registration).
    (SourceRepository.get() as any).objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    admin = await testEnv.createUser({ name: 'Ada Admin', email: `admin-${Date.now()}@test.local`, roles: ['admin'] });
    kevin = await testEnv.createUser({ name: 'Kevin', email: `kevin-${Date.now()}@test.local` });
    testEnv.actAs(admin);
  });

  it("clears the target's avatar, returns the target's row, and leaves the actor's session alone", async () => {
    await getDbAsSystem().update(tables.User, { id: kevin.id, avatarEmoji: '🦊' });

    const updated = await service.clearAvatar(kevin.id);

    // The TARGET's row moved.
    const kevinRow = await userRow(kevin.id);
    expect(kevinRow.avatarEmoji).toBeFalsy();
    expect(kevinRow.avatarFileId).toBeFalsy();

    // The returned user is the target's row, password-less.
    expect(updated.id).toBe(kevin.id);
    expect(updated.name).toBe('Kevin');
    expect((updated as any).password).toBeUndefined();

    // The actor is still signed in as themselves — the session cache was not handed the target.
    expect(new UserRepo().getUser().id).toBe(admin.id);
    expect(new UserRepo().getUser().name).toBe('Ada Admin');
  });

  it("deletes the target's stored avatar photo", async () => {
    testEnv.actAs(kevin);
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 4, g: 5, b: 6 } } })
      .png()
      .toBuffer();
    const withPhoto = await service.updateAvatarPhoto(png.toString('base64'), 'image/png');
    expect(await getFileRow(withPhoto.avatarFileId!)).toBeTruthy();
    testEnv.actAs(admin);

    await service.clearAvatar(kevin.id);

    expect(await getFileRow(withPhoto.avatarFileId!)).toBeFalsy();
    expect((await userRow(kevin.id)).avatarFileId).toBeFalsy();
  });

  it("refuses an actor without the users permission, and the target's avatar is untouched", async () => {
    const bystander = await testEnv.createUser({ name: 'Bystander', email: `bystander-${Date.now()}@test.local` });
    await getDbAsSystem().update(tables.User, { id: kevin.id, avatarEmoji: '🦊' });
    testEnv.actAs(bystander);

    await expect(service.clearAvatar(kevin.id)).rejects.toThrow(
      `Only a user manager can change another person's avatar.`
    );

    expect((await userRow(kevin.id)).avatarEmoji).toBe('🦊');
  });

  it('with no id it still clears the CALLER own avatar and refreshes their session (the existing contract)', async () => {
    testEnv.actAs(kevin);
    await service.updateAvatarEmoji('🦞');
    expect(new UserRepo().getUser().avatarEmoji).toBe('🦞');

    const updated = await service.clearAvatar();

    expect(updated.id).toBe(kevin.id);
    expect(updated.avatarEmoji).toBeFalsy();
    expect((await userRow(kevin.id)).avatarEmoji).toBeFalsy();
    // Self path: the session cache is refreshed in the same stroke.
    expect(new UserRepo().getUser().avatarEmoji).toBeFalsy();
  });
});
