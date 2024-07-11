import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const defaultPasswordResetEmailConfigFactory = SourceRepository.get().object<PasswordResetEmailConfig>(
  '@proteinjs/user-server/DefaultPasswordResetEmailConfigFactory'
);

export interface PasswordResetEmailConfig {
  subject?: string;
  getEmailContent: (token: string) => {
    text: string;
    html?: string;
  };
}

export interface DefaultPasswordResetEmailConfigFactory extends Loadable {
  getPasswordResetEmailConfig(): PasswordResetEmailConfig;
}
