import sharp from 'sharp';
import heicDecode from 'heic-decode';
import sha256 from 'crypto-js/sha256';
import { getDbAsSystem } from '@proteinjs/db';
import { FileStorage } from '@proteinjs/db-file';
import { tables, User, UserRepo, UpdatePasswordResponse, UpdatedUser, UpdateUserInfoService } from '@proteinjs/user';
import { EmailSender, getDefaultPasswordUpdatedEmailConfigFactory } from '@proteinjs/email-server';

export class UpdateUserInfo implements UpdateUserInfoService {
  /** Stored avatar photos are exactly this: cover-cropped square JPEG. */
  private static readonly AVATAR_SIZE = 512;
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

    // verify current password
    const hashedCurrentPassword = sha256(currentPassword).toString();
    const user = await db.get(tables.User, { id: userId });
    if (hashedCurrentPassword !== user.password) {
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
      const hashedNewPassword = sha256(newPassword).toString();
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

  async updateAvatarPhoto(fileData: string, mimeType: string): Promise<UpdatedUser> {
    if (!UpdateUserInfo.ACCEPTED_AVATAR_MIME_TYPES.includes(mimeType)) {
      throw new Error(
        `Unsupported avatar image type '${mimeType}'. Accepted: ${UpdateUserInfo.ACCEPTED_AVATAR_MIME_TYPES.join(', ')}`
      );
    }

    const imageBytes = Buffer.from(fileData, 'base64');
    if (imageBytes.length > UpdateUserInfo.MAX_AVATAR_PHOTO_BYTES) {
      throw new Error(`Avatar photo is too large (max 10MB)`);
    }

    const jpeg = await this.toAvatarJpeg(imageBytes, mimeType);
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

  async clearAvatar(): Promise<UpdatedUser> {
    return await this.setAvatar({ avatarEmoji: null, avatarFileId: null });
  }

  /**
   * The single door to the avatar columns — every mutation assigns BOTH, which is what enforces
   * the exactly-one-active invariant (photo OR emoji, never both). Also the previous photo's
   * cleanup point: an avatar file the user row no longer points to is unreachable (the /avatar
   * route serves only the id on the user row), so it is deleted here, after the row moves off it.
   */
  private async setAvatar(avatar: { avatarEmoji: string | null; avatarFileId: string | null }): Promise<UpdatedUser> {
    const userId = new UserRepo().getUser().id;
    const previousAvatarFileId = (await getDbAsSystem().get(tables.User, { id: userId })).avatarFileId;
    const updated = await this.saveUserInfo(avatar);
    if (previousAvatarFileId && previousAvatarFileId !== avatar.avatarFileId) {
      await new FileStorage().deleteFile(previousAvatarFileId);
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
   */
  private async saveUserInfo(changes: Partial<User>): Promise<UpdatedUser> {
    const userRepo = new UserRepo();
    const userId = userRepo.getUser().id;
    const db = getDbAsSystem();
    await db.update(tables.User, changes, { id: userId });
    const updated = await db.get(tables.User, { id: userId });
    delete (updated as Partial<User>).password; // the same password-less shape userCache caches
    userRepo.setUser(updated);
    return updated;
  }

  /**
   * Minimal avatar pipeline: decode, auto-orient from EXIF, cover-crop square, re-encode JPEG.
   * sharp drops metadata (EXIF orientation/GPS) on re-encode by default — the stored avatar
   * carries no camera metadata. HEIC/HEIF (default iPhone camera format) is decoded with WASM
   * libheif (`heic-decode`) because sharp's prebuilt libvips has no HEVC decoder. NOTE: this
   * duplicates the HEIC-normalization approach of chat-server's FileTransformer, which this
   * package cannot import (layering) — future extraction target: a shared image-transform seam.
   */
  private async toAvatarJpeg(imageBytes: Buffer, mimeType: string): Promise<Buffer> {
    const pipeline =
      mimeType === 'image/heic' || mimeType === 'image/heif'
        ? await this.decodeHeic(imageBytes)
        : sharp(imageBytes).rotate();
    return await pipeline
      .resize(UpdateUserInfo.AVATAR_SIZE, UpdateUserInfo.AVATAR_SIZE, { fit: 'cover' })
      .jpeg({ quality: UpdateUserInfo.AVATAR_JPEG_QUALITY })
      .toBuffer();
  }

  private async decodeHeic(imageBytes: Buffer): Promise<sharp.Sharp> {
    const { width, height, data } = await heicDecode({ buffer: imageBytes });
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    });
  }
}
