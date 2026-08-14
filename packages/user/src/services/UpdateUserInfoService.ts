import { Service, serviceFactory } from '@proteinjs/service';
import { User } from '../tables/UserTable';

export const getUpdateUserInfoService = serviceFactory<UpdateUserInfoService>('@proteinjs/user/UpdateUserInfoService');

/** What user-info mutations return: the updated user record, never the password hash. */
export type UpdatedUser = Omit<User, 'password'>;

export interface UpdatePasswordResponse {
  updated: boolean;
  error?: string;
}

export interface UpdateUserInfoService extends Service {
  updateName(name: string): Promise<UpdatedUser>;
  updatePassword(currentPassword: string, newPassword: string): Promise<UpdatePasswordResponse>;
  /**
   * Set a photo avatar: the image is re-encoded server-side to a 512x512 JPEG (EXIF stripped),
   * stored via FileStorage, and any previous avatar photo is deleted. Nulls `avatarEmoji`
   * (avatars are photo OR emoji, exactly one active).
   * @param fileData base64-encoded image bytes (max 10MB decoded)
   * @param mimeType one of image/jpeg, image/png, image/webp, image/heic, image/heif
   */
  updateAvatarPhoto(fileData: string, mimeType: string): Promise<UpdatedUser>;
  /** Set an emoji avatar. Nulls `avatarFileId` and deletes any previous avatar photo file. */
  updateAvatarEmoji(emoji: string): Promise<UpdatedUser>;
  /** Remove the avatar entirely (both representations; deletes any stored photo file). */
  clearAvatar(): Promise<UpdatedUser>;
}
