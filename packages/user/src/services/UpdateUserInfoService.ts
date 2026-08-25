import { Service, serviceFactory } from '@proteinjs/service';
import { User } from '../tables/UserTable';

export const getUpdateUserInfoService = serviceFactory<UpdateUserInfoService>('@proteinjs/user/UpdateUserInfoService');

/** What user-info mutations return: the updated user record, never the password hash. */
export type UpdatedUser = Omit<User, 'password'>;

export interface UpdatePasswordResponse {
  updated: boolean;
  error?: string;
}

/**
 * Square region of source-image pixels to keep as the avatar, in the image's DISPLAYED
 * (EXIF-oriented) pixel space — exactly what the client crop stage frames (`cropRect` in the
 * account UI). The server clamps/rounds it against the decoded image, so fractional drag
 * offsets are fine.
 */
export interface AvatarCrop {
  /** Left edge of the square, px from the oriented image's left. */
  sx: number;
  /** Top edge of the square, px from the oriented image's top. */
  sy: number;
  /** Edge length of the square, px. */
  size: number;
}

export interface UpdateUserInfoService extends Service {
  updateName(name: string): Promise<UpdatedUser>;
  updatePassword(currentPassword: string, newPassword: string): Promise<UpdatePasswordResponse>;
  /**
   * Set a photo avatar from the ORIGINAL image bytes: the server auto-orients, crops to
   * `crop` (or center-crops square when absent), and re-encodes to a square JPEG capped at
   * 512px — never enlarged past the source's own pixels (a small photo stays its honest
   * size instead of gaining invented, blurry pixels). EXIF is stripped, the file is stored
   * via FileStorage, and any previous avatar photo is deleted. Nulls `avatarEmoji`
   * (avatars are photo OR emoji, exactly one active).
   *
   * Clients must NOT pre-resample (canvas exports bake in low-quality scaling); send the
   * bytes the user picked plus the crop frame, and let the one server pipeline do the one
   * resize.
   * @param fileData base64-encoded original image bytes (max 10MB decoded)
   * @param mimeType one of image/jpeg, image/png, image/webp, image/heic, image/heif
   * @param crop optional square frame in oriented-source pixels; absent = centered cover crop
   */
  updateAvatarPhoto(fileData: string, mimeType: string, crop?: AvatarCrop): Promise<UpdatedUser>;
  /** Set an emoji avatar. Nulls `avatarFileId` and deletes any previous avatar photo file. */
  updateAvatarEmoji(emoji: string): Promise<UpdatedUser>;
  /** Remove the avatar entirely (both representations; deletes any stored photo file). */
  clearAvatar(): Promise<UpdatedUser>;
}
