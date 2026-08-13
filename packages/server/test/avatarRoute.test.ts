import sharp from 'sharp';
import { guestUser, avatarRoute } from '@proteinjs/user';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';
import { avatar } from '../src/routes/avatar';

const testEnv = new UserServerTestEnvironment();

/** Captures exactly what the route writes — status, headers, body. */
class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: any;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  send(body?: any) {
    this.body = body;
    return this;
  }
}

const requestAvatar = async (userId: string): Promise<MockResponse> => {
  const response = new MockResponse();
  await avatar.onRequest({ params: { userId } } as any, response as any);
  return response;
};

/**
 * The shared-visibility door for avatar photos: logged-in users can render ANY user's avatar
 * (File rows are ScopedRecords, so /file/:id can't serve them cross-user); logged-out requests
 * get 401; emoji/no-avatar users get 404 (clients render emoji/initials from the user record).
 * Only the file id stored on the user row is ever served.
 */
describe('GET /avatar/:userId', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  });

  afterAll(async () => {
    await testEnv.afterAll();
  });

  it("serves another user's avatar photo to any logged-in (non-admin) user, cacheable by fileId", async () => {
    const owner = await testEnv.createUser({ name: 'Owner', email: 'owner@test.local' });
    testEnv.actAs(owner);
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 5, g: 150, b: 90 } } })
      .png()
      .toBuffer();
    const updated = await new UpdateUserInfo().updateAvatarPhoto(png.toString('base64'), 'image/png');

    // A DIFFERENT, non-admin user fetches it — the file row is scoped to the owner, so this
    // only works through the route's narrow system read.
    const viewer = await testEnv.createUser({ name: 'Viewer', email: 'viewer@test.local', roles: '' });
    testEnv.actAs(viewer);
    const response = await requestAvatar(owner.id);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('public, max-age=86400, immutable');
    const bytes = response.body as Buffer;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes[0]).toBe(0xff); // JPEG SOI
    expect(bytes[1]).toBe(0xd8);
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);

    // The client-side URL contract carries the cache-buster.
    expect(avatarRoute.path(owner.id, updated.avatarFileId!)).toBe(`/avatar/${owner.id}?v=${updated.avatarFileId}`);
  });

  it('404s for an emoji-avatar user and a no-avatar user (photos only)', async () => {
    const emojiUser = await testEnv.createUser({ name: 'Emoji', email: 'emoji-route@test.local' });
    testEnv.actAs(emojiUser);
    await new UpdateUserInfo().updateAvatarEmoji('🦀');
    const bareUser = await testEnv.createUser({ name: 'Bare', email: 'bare-route@test.local' });

    testEnv.actAs(bareUser);
    expect((await requestAvatar(emojiUser.id)).statusCode).toBe(404);
    expect((await requestAvatar(bareUser.id)).statusCode).toBe(404);
  });

  it('404s for unknown ids — :userId is a keyed lookup, never a path', async () => {
    const viewer = await testEnv.createUser({ name: 'Curious', email: 'curious@test.local' });
    testEnv.actAs(viewer);
    expect((await requestAvatar('no-such-user')).statusCode).toBe(404);
    expect((await requestAvatar('../../etc/passwd')).statusCode).toBe(404);
  });

  it('401s without a logged-in session', async () => {
    const owner = await testEnv.createUser({ name: 'Private', email: 'private@test.local' });
    testEnv.actAs(owner);
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .png()
      .toBuffer();
    await new UpdateUserInfo().updateAvatarPhoto(png.toString('base64'), 'image/png');

    testEnv.actAs(guestUser as any);
    const response = await requestAvatar(owner.id);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toBeInstanceOf(Buffer);
  });
});
