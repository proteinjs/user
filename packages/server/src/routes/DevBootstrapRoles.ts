import type { BootstrapRolesOutcome } from '../services/Roles';

/**
 * The `DEV_BOOTSTRAP_ROLES` contract of the dev role-bootstrap door (routes/devLogin.ts):
 *
 *   DEV_BOOTSTRAP_ROLES='email:role[,role];email:role…'
 *
 * Addresses and roles are trimmed; addresses are lowercased (the normalization every account
 * email gets); a repeated address unions its roles; an entry with no `:`, no address or no role
 * is ignored (malformed input is skipped, never fatal). The door grants the listed roles the
 * account does not hold and logs ONE marker line per hit for a listed address —
 * `[dev-bootstrap] <email>: granted a, b; held c; refused d (why)` — which tooling that provisions
 * a development database can read back from the server log as proof of the grant.
 */
export class DevBootstrapRoles {
  /** The roles listed for `email` in the process env (empty when the variable is unset or the address is not listed). */
  static rolesFor(email: string): string[] {
    return DevBootstrapRoles.parse(process.env.DEV_BOOTSTRAP_ROLES).get(email.trim().toLowerCase()) ?? [];
  }

  static parse(value: string | undefined): Map<string, string[]> {
    const entries = new Map<string, string[]>();
    for (const entry of (value ?? '').split(';')) {
      const colon = entry.indexOf(':');
      if (colon < 0) {
        continue;
      }
      const email = entry.slice(0, colon).trim().toLowerCase();
      const roles = entry
        .slice(colon + 1)
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean);
      if (!email || roles.length === 0) {
        continue;
      }
      entries.set(email, Array.from(new Set([...(entries.get(email) ?? []), ...roles])));
    }
    return entries;
  }

  /** The one marker line per hit — a log contract its readers parse; change the shape only together with them. */
  static markerLine(email: string, outcome: BootstrapRolesOutcome): string {
    const list = (items: string[]) => (items.length ? items.join(', ') : '(none)');
    return (
      `[dev-bootstrap] ${email}: granted ${list(outcome.granted)}; held ${list(outcome.held)}; ` +
      `refused ${list(outcome.refused.map((refusal) => `${refusal.role} (${refusal.why})`))}`
    );
  }
}
