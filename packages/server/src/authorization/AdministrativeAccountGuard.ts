import { Logger } from '@proteinjs/logger';
import { RolesCatalog, UserAuth, UserRepo } from '@proteinjs/user';

/** An act on another account's identity — whoever completes it can sign in as that account. */
export type AccountIdentityAct = 'address change' | 'machine credential mint';

/** The account an act targets: its id (for the log) and every role its identity carries. */
export type AccountIdentityTarget = { id: string; roles: readonly string[] };

/**
 * The ONE owner of "may this caller act on that account's identity". Whoever holds an account's
 * sign-in address (the reset link is mailed there) or its machine credential holds the account,
 * and every role on it. So an act on the identity of an account that holds an administrative role
 * (`RolesCatalog.isAdministrative`: break-glass, admin-grant-only or marked administrative) is the
 * `admin` role's alone, never the `users` door's: a caller without `admin` is refused in words,
 * the refusal is kept in one log line naming the actor, the target and the roles (never an
 * address), and the caller writes nothing — a refused act leaves no audit row, the Roles service's
 * precedent. An account that holds no administrative role stays the door's.
 *
 * Asked by `UserAccountAdmin.setEmail` (the address) and `MachineCredentials.mintCredential` (a
 * declared machine's credential); the next door that hands over an account's identity asks it too.
 */
export class AdministrativeAccountGuard {
  /** Each act's name in the refusal's log line, and what the refusal says the caller tried. */
  private static readonly ACTS: Record<AccountIdentityAct, { logged: string; tried: string }> = {
    'address change': { logged: 'an address change', tried: 'change the address of an account' },
    'machine credential mint': {
      logged: 'a machine credential mint',
      tried: 'mint the credential of a machine account',
    },
  };

  /** Throws the refusal's words, after its log line, unless the caller may do `act` to `target`. */
  refuseUnlessAllowed(act: AccountIdentityAct, target: AccountIdentityTarget): void {
    const administrative = this.administrativeRoles(target.roles);
    if (administrative.length === 0 || UserAuth.hasRole('admin')) {
      return;
    }

    const words = AdministrativeAccountGuard.ACTS[act];
    new Logger({ name: 'AdministrativeAccountGuard' }).warn({
      message: `Refused ${words.logged} on an administrative account`,
      obj: { actor: new UserRepo().getUser().id, target: target.id, roles: administrative },
    });
    throw new Error(
      `Only an admin can ${words.tried} that holds an administrative role ` +
        `('${administrative.join("', '")}') — the 'users' permission does not cover it.`
    );
  }

  /** The administrative roles among `roles`, each once, in the order held. */
  private administrativeRoles(roles: readonly string[]): string[] {
    return roles.filter((role, at) => roles.indexOf(role) === at && RolesCatalog.isAdministrative(role));
  }
}
