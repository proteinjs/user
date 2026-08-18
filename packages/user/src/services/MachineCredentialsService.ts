import { Service, serviceFactory } from '@proteinjs/service';

export const getMachineCredentialsService = serviceFactory<MachineCredentialsService>(
  '@proteinjs/user/MachineCredentialsService'
);

/** The one-time view of a minted machine credential — the plaintext is never stored. */
export type MintedMachineCredential = {
  /** The machine account the credential was minted for. */
  email: string;
  /** The generated password — shown exactly ONCE; only its hash is stored. */
  password: string;
  /** The Secret Manager secret the declaration names as the credential's home. */
  secretName: string;
  /** Operator instruction: where to paste the plaintext and what activates it. */
  note: string;
};

/** A declared machine account joined with its row state — the admin surface renders these. */
export type MachineAccountView = {
  email: string;
  accountName: string;
  roles: string[];
  secretName: string;
  /** 'pending first boot' until the boot sync has created/adopted the row. */
  status: 'active' | 'deactivated' | 'pending first boot';
  /** Whether a credential has ever been minted/provisioned (hash present on the row). */
  hasCredential: boolean;
};

/**
 * Credential minting for code-declared machine accounts (`MachineAccount`): identity and grants
 * live in source; the credential is the ONLY runtime-provisioned piece. Minting generates a
 * strong random password, stores its hash on the account row (no human-chosen passwords), kills
 * the account's sessions, and returns the plaintext once for pasting into the declaration's
 * Secret Manager secret. The same call rotates. Machine rows only — human credentials go
 * through the password-reset flow.
 */
export interface MachineCredentialsService extends Service {
  /** Every declared machine account with its row state, for the admin surface. */
  listMachineAccounts(): Promise<MachineAccountView[]>;
  mintCredential(email: string): Promise<MintedMachineCredential>;
}
