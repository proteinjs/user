import { randomBytes } from 'crypto';
import { getDbAsSystem } from '@proteinjs/db';
import {
  MachineAccountView,
  MachineCredentialsService,
  MintedMachineCredential,
  USER_PERMISSIONS,
  getMachineAccounts,
  tables,
} from '@proteinjs/user';
import { Logger } from '@proteinjs/logger';
import { Service } from '@proteinjs/service';
import { PasswordHasher } from '../authentication/PasswordHasher';

/**
 * Credential minting for code-declared machine accounts — the ONLY manual step in a machine
 * account's life (identity and grants come from the `MachineAccount` declaration at boot).
 *
 * Generates a strong random password (never human-chosen), stores its hash on the account row
 * via PasswordHasher's machine mode — sha256, deliberately not the argon2id human KDF: a
 * generated 256-bit secret gains nothing from key stretching, and the bridge logs in fresh per
 * poll, so verifies stay cheap. (The plaintext is never persisted or logged.) Kills the
 * account's existing sessions (the old
 * credential dies with them), and returns the plaintext ONCE for pasting into the declaration's
 * Secret Manager secret. The same call rotates. Machine rows only (`is_loaded_from_source`);
 * human credentials go through the password-reset flow.
 */
export class MachineCredentials implements MachineCredentialsService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      permission: USER_PERMISSIONS.users,
    },
  };

  async listMachineAccounts(): Promise<MachineAccountView[]> {
    const db = getDbAsSystem();
    const views: MachineAccountView[] = [];
    for (const declaration of getMachineAccounts()) {
      const row = await db.get(tables.User, { email: declaration.email });
      const booted = !!row && row.isLoadedFromSource === true;
      views.push({
        email: declaration.email,
        accountName: declaration.accountName,
        roles: [...declaration.roles],
        secretName: declaration.secretName,
        status: booted ? (row.status === 'deactivated' ? 'deactivated' : 'active') : 'pending first boot',
        hasCredential: booted && !!row.password,
      });
    }

    return views;
  }

  async mintCredential(email: string): Promise<MintedMachineCredential> {
    const logger = new Logger({ name: 'MachineCredentials.mintCredential' });
    const normalizedEmail = email?.toLowerCase();
    const declaration = getMachineAccounts().find((machineAccount) => machineAccount.email === normalizedEmail);
    if (!declaration) {
      throw new Error(
        `No machine account is declared for '${email}'. Credentials can only be minted for ` +
          `code-declared machine accounts (MachineAccount declarations).`
      );
    }

    const db = getDbAsSystem();
    const user = await db.get(tables.User, { email: normalizedEmail });
    if (!user || user.isLoadedFromSource !== true) {
      throw new Error(
        `The machine account row for '${normalizedEmail}' has not been loaded from source yet — ` +
          `the boot sync creates (or adopts) it. Boot the server with the declaration, then mint.`
      );
    }

    // 256 bits of entropy; standard API-key UX — generated, shown once, hash-only at rest.
    const password = randomBytes(32).toString('hex');
    await db.update(tables.User, { id: user.id, password: await new PasswordHasher().hash(password, 'machine') });
    // Rotation kills the old credential's sessions immediately (the bridge logs in fresh per
    // poll, so this is cheap for it — the mechanism is the categorical one).
    await db.delete(tables.Session, { userEmail: normalizedEmail });
    logger.info({
      message: `Minted machine credential`,
      obj: { email: normalizedEmail, secretName: declaration.secretName },
    });

    return {
      email: normalizedEmail,
      password,
      secretName: declaration.secretName,
      note:
        `Shown once. Paste this password into the '${declaration.secretName}' Secret Manager ` +
        `secret, then restart the service that reads it — the previous credential is already invalid.`,
    };
  }
}
