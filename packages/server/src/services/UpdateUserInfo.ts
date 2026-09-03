import sharp from 'sharp';
import heicDecode from 'heic-decode';
import { getDbAsSystem } from '@proteinjs/db';
import { File, FileStorage, tables as fileTables } from '@proteinjs/db-file';
import {
  tables,
  User,
  UserAuth,
  UserRepo,
  USER_PERMISSIONS,
  UpdatePasswordResponse,
  UpdatedUser,
  UpdateUserInfoService,
  AvatarCrop,
  getScopedDbAsSystem,
} from '@proteinjs/user';
import { EmailSender, getDefaultPasswordUpdatedEmailConfigFactory } from '@proteinjs/email-server';
import { PasswordHasher } from '../authentication/PasswordHasher';

export class UpdateUserInfo implements UpdateUserInfoService {
  /**
   * Stored avatar photos are square JPEGs capped at this edge — and never ENLARGED to it: a
   * source (or crop) smaller than the cap keeps its honest pixel count. Upscaling a small photo
   * to a fixed 512 invents pixels that read as permanent blur on every chip that renders it
   * (the founder's fuzzy-avatar defect); the display layer downscales crisply from whatever
   * honest size is stored.
   */
  private static readonly AVATAR_MAX_SIZE = 512;
  private static readonly AVATAR_JPEG_QUALITY = 85;
  private static readonly MAX_AVATAR_PHOTO_BYTES = 10 * 1024 * 1024;
  private static readonly ACCEPTED_AVATAR_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  ];
  /** One emoji (possibly a ZWJ/flag/keycap sequence) — a handful of code units, never a sentence. */
  private static readonly MAX_AVATAR_EMOJI_LENGTH = 16;
  /** Constructed (not a literal) because tsconfig targets es5; runs on Node, which supports `\p`. */
  private static readonly EMOJI_PATTERN = new RegExp('[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3]', 'u');

  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  async updateName(name: string): Promise<UpdatedUser> {
    return await this.saveUserInfo({ name });
  }

  async updatePassword(currentPassword: string, newPassword: string): Promise<UpdatePasswordResponse> {
    const db = getDbAsSystem();
    const userId = new UserRepo().getUser().id;

    // verify current password (format-discriminating: legacy sha256 rows verify too)
    const user = await db.get(tables.User, { id: userId });
    if (!(await new PasswordHasher().verify(user.password, currentPassword))) {
      return {
        updated: false,
        error: `Invalid password`,
      };
    }

    try {
      const emailSender = new EmailSender();
      const defaultConfigFactory = getDefaultPasswordUpdatedEmailConfigFactory();
      const config = defaultConfigFactory.getConfig();

      // send email to user that their password changed
      await emailSender.sendEmail({
        to: user.email,
        subject: config.options?.subject || 'Your password has been changed',
        text: config.text,
        html: config.html,
        ...config.options,
      });
    } catch (error: any) {
      return {
        updated: false,
        error: `Email failed to send`,
      };
    }

    // If email is sent successfully,
    // hash and store new password
    try {
      const hashedNewPassword = await new PasswordHasher().hash(newPassword);
      await this.saveUserInfo({ password: hashedNewPassword });
    } catch (error: any) {
      return {
        updated: false,
        error: `Password db update failed`,
      };
    }

    return {
      updated: true,
    };
  }

  async updateAvatarPhoto(fileData: string, mimeType: string, crop?: AvatarCrop): Promise<UpdatedUser> {
    if (!UpdateUserInfo.ACCEPTED_AVATAR_MIME_TYPES.includes(mimeType)) {
      throw new Error(
        `Unsupported avatar image type '${mimeType}'. Accepted: ${UpdateUserInfo.ACCEPTED_AVATAR_MIME_TYPES.join(', ')}`
      );
    }

    const imageBytes = Buffer.from(fileData, 'base64');
    if (imageBytes.length > UpdateUserInfo.MAX_AVATAR_PHOTO_BYTES) {
      throw new Error(`Avatar photo is too large (max 10MB)`);
    }

    const jpeg = await this.toAvatarJpeg(imageBytes, mimeType, crop);
    const file = await new FileStorage().createFile(
      { name: 'avatar.jpg', type: 'image/jpeg', size: jpeg.length },
      jpeg.toString('base64')
    );
    return await this.setAvatar({ avatarEmoji: null, avatarFileId: file.id });
  }

  async updateAvatarEmoji(emoji: string): Promise<UpdatedUser> {
    const trimmed = emoji.trim();
    if (
      !trimmed ||
      trimmed.length > UpdateUserInfo.MAX_AVATAR_EMOJI_LENGTH ||
      /\s/.test(trimmed) ||
      !UpdateUserInfo.EMOJI_PATTERN.test(trimmed)
    ) {
      throw new Error(`Avatar emoji must be a single short emoji`);
    }

    return await this.setAvatar({ avatarEmoji: trimmed, avatarFileId: null });
  }

  async clearAvatar(userId?: string): Promise<UpdatedUser> {
    return await this.setAvatar({ avatarEmoji: null, avatarFileId: null }, userId);
  }

  /**
   * The read-only half of `saveUserInfo`: no write, just the stored row pulled back into the
   * session cache. Every mutation through this service already refreshes the cache, so this is
   * for changes made ELSEWHERE — another device, another tab, a user manager — which the cached
   * user would otherwise keep hiding until the next sign-in.
   */
  async refresh(): Promise<UpdatedUser> {
    const userRepo = new UserRepo();
    const updated = await getDbAsSystem().get(tables.User, { id: userRepo.getUser().id });
    delete (updated as Partial<User>).password; // the same password-less shape userCache caches
    userRepo.setUser(updated);
    return updated;
  }

  /**
   * The single door to the avatar columns — every mutation assigns BOTH, which is what enforces
   * the exactly-one-active invariant (photo OR emoji, never both). Also the previous photo's
   * cleanup point: an avatar file the user row no longer points to is unreachable (the /avatar
   * route serves only the id on the user row), so it is deleted here, after the row moves off it.
   *
   * `userId` names ANOTHER person (see {@link resolveTarget} for the permission that admits it);
   * everything below then applies to that person's row and their previous photo.
   */
  private async setAvatar(
    avatar: { avatarEmoji: string | null; avatarFileId: string | null },
    userId?: string
  ): Promise<UpdatedUser> {
    const { targetUserId } = this.resolveTarget(userId);
    const previousAvatarFileId = (await getDbAsSystem().get(tables.User, { id: targetUserId })).avatarFileId;
    const updated = await this.saveUserInfo(avatar, userId);
    if (previousAvatarFileId && previousAvatarFileId !== avatar.avatarFileId) {
      // Deleted as SYSTEM, like the user-row write it accompanies: the file lives in the TARGET's
      // scope, and a caller-scoped delete (`FileStorage.deleteFile`) would silently match nothing
      // when a user manager clears someone else's photo, orphaning the bytes. This door has
      // already made its own access decision, the same shape as the /avatar route's system read.
      // The bytes still die with the row — `FileStorageTableWatcher` fires for every file-row
      // delete path, system sweeps included.
      await getScopedDbAsSystem<File>().delete(fileTables.File, { id: previousAvatarFileId });
    }

    return updated;
  }

  /**
   * The one path every user-info mutation persists through: writes the changes AND refreshes the
   * server session cache in the same stroke. userCache serializes the user into session data at
   * request start; a bare DB write leaves every read through UserRepo in the same context — and
   * long-lived contexts that keep their session data (sockets) — serving the STALE user until
   * re-login (the rename wart). Fusing persist + refresh here means no future mutation can
   * reintroduce that class of staleness.
   *
   * The refresh is the CALLER's own cache, so it happens only when the caller is the target. A
   * user manager changing someone else writes the row and stops there: refreshing would hand the
   * admin the target's row as their own identity, and there is no way to reach the target's
   * session from here anyway — their next sign-in reads the row.
   */
  private async saveUserInfo(changes: Partial<User>, userId?: string): Promise<UpdatedUser> {
    const userRepo = new UserRepo();
    const { targetUserId, targetIsCaller } = this.resolveTarget(userId);
    const db = getDbAsSystem();
    await db.update(tables.User, changes, { id: targetUserId });
    const updated = await db.get(tables.User, { id: targetUserId });
    delete (updated as Partial<User>).password; // the same password-less shape userCache caches
    if (targetIsCaller) {
      userRepo.setUser(updated);
    }

    return updated;
  }

  /**
   * The user a mutation targets, and whether that is the caller.
   *
   * The service door is `allUsers` — it has to be, every signed-in user manages their own
   * profile through it — so naming ANOTHER person's id is authorized here, in-body and
   * fail-closed: only a `users` permission holder may do it.
   */
  private resolveTarget(userId?: string): { targetUserId: string; targetIsCaller: boolean } {
    const callerId = new UserRepo().getUser().id;
    const targetUserId = userId ?? callerId;
    const targetIsCaller = targetUserId === callerId;
    if (!targetIsCaller && !UserAuth.hasPermission(USER_PERMISSIONS.users)) {
      throw new Error(`Only a user manager can change another person's avatar.`);
    }

    return { targetUserId, targetIsCaller };
  }

  /**
   * THE avatar image pipeline — the only place avatar pixels are ever resampled: decode,
   * auto-orient from EXIF, extract the crop frame (client-framed, or the centered square),
   * one high-quality resize down to at most AVATAR_MAX_SIZE (never up), re-encode JPEG.
   * Clients send ORIGINAL bytes; a client-side canvas export would resample a second time
   * (and with the browser's low-default smoothing), baking blur into the stored master.
   * sharp drops metadata (EXIF orientation/GPS) on re-encode by default — the stored avatar
   * carries no camera metadata. HEIC/HEIF (default iPhone camera format) is decoded with WASM
   * libheif (`heic-decode`) because sharp's prebuilt libvips has no HEVC decoder. NOTE: this
   * duplicates the HEIC-normalization approach of chat-server's FileTransformer, which this
   * package cannot import (layering) — future extraction target: a shared image-transform seam.
   */
  private async toAvatarJpeg(imageBytes: Buffer, mimeType: string, crop?: AvatarCrop): Promise<Buffer> {
    const pipeline =
      mimeType === 'image/heic' || mimeType === 'image/heif'
        ? await this.decodeHeic(imageBytes)
        : sharp(imageBytes).rotate();
    const { width, height } = await this.orientedDimensions(pipeline);
    const frame = this.clampCrop(crop, width, height);
    const target = Math.min(UpdateUserInfo.AVATAR_MAX_SIZE, frame.size);
    return await pipeline
      .extract({ left: frame.left, top: frame.top, width: frame.size, height: frame.size })
      .resize(target, target, { fit: 'cover' })
      .jpeg({ quality: UpdateUserInfo.AVATAR_JPEG_QUALITY })
      .toBuffer();
  }

  /**
   * The decoded image's dimensions in DISPLAYED (EXIF-oriented) pixel space — the space the
   * client framed its crop in, and the space `.rotate()` makes `.extract` operate in.
   * Orientations 5-8 transpose the encoded axes.
   */
  private async orientedDimensions(pipeline: sharp.Sharp): Promise<{ width: number; height: number }> {
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Could not read avatar image dimensions`);
    }

    const transposed = (metadata.orientation ?? 1) >= 5;
    return {
      width: transposed ? metadata.height : metadata.width,
      height: transposed ? metadata.width : metadata.height,
    };
  }

  /**
   * Resolve the crop request against the real image: round to whole pixels and clamp fully
   * inside the oriented bounds, staying square. Absent crop = the centered square (identical
   * to the old `fit: cover` center-crop, so no-crop clients keep byte-equivalent behavior).
   */
  private clampCrop(
    crop: AvatarCrop | undefined,
    width: number,
    height: number
  ): { left: number; top: number; size: number } {
    const maxSize = Math.min(width, height);
    if (!crop) {
      return { left: Math.floor((width - maxSize) / 2), top: Math.floor((height - maxSize) / 2), size: maxSize };
    }

    if (![crop.sx, crop.sy, crop.size].every(Number.isFinite)) {
      throw new Error(`Avatar crop must be numeric`);
    }

    const size = Math.min(Math.max(1, Math.round(crop.size)), maxSize);
    const clampOffset = (value: number, max: number) => Math.min(Math.max(0, Math.round(value)), max);
    return { left: clampOffset(crop.sx, width - size), top: clampOffset(crop.sy, height - size), size };
  }

  private async decodeHeic(imageBytes: Buffer): Promise<sharp.Sharp> {
    const { width, height, data } = await heicDecode({ buffer: imageBytes });
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    });
  }
}
