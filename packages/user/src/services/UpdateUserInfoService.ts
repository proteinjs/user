import { Service, serviceFactory } from '@proteinjs/service';

export const getUpdateUserInfoService = serviceFactory<UpdateUserInfoService>('@proteinjs/user/UpdateUserInfoService');

export interface UpdatePasswordResponse {
  updated: boolean;
  error?: string;
}

export interface UpdateUserInfoService extends Service {
  updateName(name: string): Promise<void>;
  updatePassword(currentPassword: string, newPassword: string): Promise<UpdatePasswordResponse>;
}
