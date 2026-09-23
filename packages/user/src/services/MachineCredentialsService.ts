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

/**
 * Why the boot sync refused a machine-account declaration: a row it does not own holds the
 * declared address, and the sync never takes such a row over.
 */
export type MachineAccountRefusal = 'a person holds this address' | 'a hand-made machine row holds this address';

/** A declared machine account joined with its row state — the admin surface renders these. */
export type MachineAccountView = {
  email: string;
  accountName: string;
  roles: string[];
  secretName: string;
  /**
   * 'pending first boot' until the boot sync has created the row; 'declaration refused' while a row
   * the sync does not own holds the address (the sync never takes it over — `refusal` says whose).
   */
  status: 'active' | 'deactivated' | 'pending first boot' | 'declaration refused';
  /** Why the declaration was refused — present exactly when `status` is 'declaration refused'. */
  refusal?: MachineAccountRefusal;
  /** Whether a credential has been minted for the account (hash present on its own row). */
  hasCredential: boolean;
};

/**
 * Credential minting for code-declared machine accounts (`MachineAccount`): identity and grants
 * live in source; the credential is the ONLY runtime-provisioned piece. Minting generates a
 * strong random password, stores its hash on the account row (no human-chosen passwords), kills
 * the account's sessions, and returns the plaintext once for pasting into the declaration's
 * Secret Manager secret. The same call rotates. Machine rows only — human credentials go
 * through the password-reset flow, and a declaration the boot sync refused has no row to mint
 * for (the mint says why).
 */
export interface MachineCredentialsService extends Service {
  /** Every declared machine account with its row state, for the admin surface. */
  listMachineAccounts(): Promise<MachineAccountView[]>;
  mintCredential(email: string): Promise<MintedMachineCredential>;
}
