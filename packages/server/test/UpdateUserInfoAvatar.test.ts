import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getDbAsSystem } from '@proteinjs/db';
import { FileStorage, File, tables as fileTables } from '@proteinjs/db-file';
import { tables, UserRepo, getScopedDbAsSystem } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';

const testEnv = new UserServerTestEnvironment();

/** JPEG magic bytes (SOI + marker prefix). */
const isJpeg = (buffer: Buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

const getFileRow = async (fileId: string) => await getScopedDbAsSystem<File>().get(fileTables.File, { id: fileId });

/**
 * Avatars are photo OR emoji — exactly one active — stored as a square JPEG capped at 512px
 * (never enlarged past the source's honest pixels; see AvatarPhotoFidelity.test.ts), previous photo file
 * deleted on every change, and the server session cache refreshed in the same stroke (the same
 * helper that fixes the updateName rename-staleness wart). All assertions are outcomes: rows,
 * bytes, cache reads.
 */
describe('UpdateUserInfo avatar mutations', () => {
  const service = new UpdateUserInfo();

  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it('updateAvatarPhoto stores a 512x512 JPEG file and points the user row at it', async () => {
    const user = await testEnv.createUser({ name: 'Photo user', email: 'photo@test.local' });
    testEnv.actAs(user);
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 80, b: 40 } },
    })
      .png()
      .toBuffer();

    const updated = await service.updateAvatarPhoto(png.toString('base64'), 'image/png');

    // Returned user: photo active, emoji null, no password hash.
    expect(updated.avatarFileId).toBeTruthy();
    expect(updated.avatarEmoji).toBeFalsy();
    expect((updated as any).password).toBeUndefined();

    // User row persisted with the exactly-one invariant.
    const row = await getDbAsSystem().get(tables.User, { id: user.id });
    expect(row.avatarFileId).toBe(updated.avatarFileId);
    expect(row.avatarEmoji).toBeFalsy();

    // File row + bytes written: a real 512x512 JPEG.
    const file = await getFileRow(row.avatarFileId!);
    expect(file).toBeTruthy();
    expect(file.type).toBe('image/jpeg');
    const bytes = Buffer.from(await new FileStorage().getFileData(file.id), 'base64');
    expect(isJpeg(bytes)).toBe(true);
    expect(file.size).toBe(bytes.length);
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);

    // Session cache refreshed in the same stroke.
    expect(new UserRepo().getUser().avatarFileId).toBe(row.avatarFileId);
  });

  it('a second updateAvatarPhoto deletes the previous avatar file', async () => {
    const user = await testEnv.createUser({ name: 'Replacer', email: 'replace@test.local' });
    testEnv.actAs(user);
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 120, b: 200 } } })
      .png()
      .toBuffer();

    const first = await service.updateAvatarPhoto(png.toString('base64'), 'image/png');
    const second = await service.updateAvatarPhoto(png.toString('base64'), 'image/png');
    expect(second.avatarFileId).not.toBe(first.avatarFileId);

    // The prior file is gone — row and bytes (the byte store checked directly through the
    // driver: the gated service read now refuses ids with no readable row by design).
    expect(await getFileRow(first.avatarFileId!)).toBeFalsy();
    expect(await FileStorage.getDriver().getFileData(first.avatarFileId!)).toBe('');
    // The new one is intact.
    expect(await getFileRow(second.avatarFileId!)).toBeTruthy();
  });

  it('updateAvatarPhoto normalizes HEIC (default iPhone camera format) to JPEG at its honest size', async () => {
    const user = await testEnv.createUser({ name: 'iPhone user', email: 'heic@test.local' });
    testEnv.actAs(user);
    // The fixture is 96x64 — small on purpose: the stored master is its centered 64px square,
    // NOT an enlarged 512 (enlargement invents pixels that read as permanent blur).
    const heic = fs.readFileSync(path.join(__dirname, 'fixtures', 'fixture.heic'));

    const updated = await service.updateAvatarPhoto(heic.toString('base64'), 'image/heic');

    const bytes = Buffer.from(await new FileStorage().getFileData(updated.avatarFileId!), 'base64');
    expect(isJpeg(bytes)).toBe(true);
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(64);
  });

  it('updateAvatarEmoji sets the emoji, nulls the photo, and deletes the previous photo file', async () => {
    const user = await testEnv.createUser({ name: 'Emoji user', email: 'emoji@test.local' });
    testEnv.actAs(user);
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .png()
      .toBuffer();
    const withPhoto = await service.updateAvatarPhoto(png.toString('base64'), 'image/png');

    const updated = await service.updateAvatarEmoji('🦞');

    // Exactly-one invariant, in the row and the returned user.
    expect(updated.avatarEmoji).toBe('🦞');
    expect(updated.avatarFileId).toBeFalsy();
    const row = await getDbAsSystem().get(tables.User, { id: user.id });
    expect(row.avatarEmoji).toBe('🦞');
    expect(row.avatarFileId).toBeFalsy();

    // Previous photo file deleted; session cache refreshed.
    expect(await getFileRow(withPhoto.avatarFileId!)).toBeFalsy();
    expect(new UserRepo().getUser().avatarEmoji).toBe('🦞');
  });

  it('accepts multi-codepoint emoji (ZWJ sequences)', async () => {
    const user = await testEnv.createUser({ name: 'Astronaut', email: 'zwj@test.local' });
    testEnv.actAs(user);
    const updated = await service.updateAvatarEmoji('👩‍🚀');
    expect(updated.avatarEmoji).toBe('👩‍🚀');
  });

  it('clearAvatar removes both representations and the stored photo file', async () => {
    const user = await testEnv.createUser({ name: 'Clearer', email: 'clear@test.local' });
    testEnv.actAs(user);
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const withPhoto = await service.updateAvatarPhoto(png.toString('base64'), 'image/png');

    const updated = await service.clearAvatar();

    expect(updated.avatarEmoji).toBeFalsy();
    expect(updated.avatarFileId).toBeFalsy();
    const row = await getDbAsSystem().get(tables.User, { id: user.id });
    expect(row.avatarEmoji).toBeFalsy();
    expect(row.avatarFileId).toBeFalsy();
    expect(await getFileRow(withPhoto.avatarFileId!)).toBeFalsy();
    expect(new UserRepo().getUser().avatarFileId).toBeFalsy();
  });

  it('rejects oversized photos before transforming, and unsupported types', async () => {
    const user = await testEnv.createUser({ name: 'Rejected', email: 'reject@test.local' });
    testEnv.actAs(user);

    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(service.updateAvatarPhoto(oversized.toString('base64'), 'image/png')).rejects.toThrow(/too large/);
    await expect(service.updateAvatarPhoto(Buffer.alloc(10).toString('base64'), 'image/gif')).rejects.toThrow(
      /Unsupported avatar image type/
    );

    // Neither rejection touched the user row.
    const row = await getDbAsSystem().get(tables.User, { id: user.id });
    expect(row.avatarFileId).toBeFalsy();
    expect(row.avatarEmoji).toBeFalsy();
  });

  it('rejects non-emoji strings as avatar emoji', async () => {
    const user = await testEnv.createUser({ name: 'Wordy', email: 'wordy@test.local' });
    testEnv.actAs(user);

    await expect(service.updateAvatarEmoji('hello')).rejects.toThrow(/single short emoji/);
    await expect(service.updateAvatarEmoji('')).rejects.toThrow(/single short emoji/);
    await expect(service.updateAvatarEmoji('🦞🦞🦞🦞🦞🦞🦞🦞🦞')).rejects.toThrow(/single short emoji/);
  });
});
