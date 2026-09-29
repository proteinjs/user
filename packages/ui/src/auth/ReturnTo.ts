/**
 * Where a successful sign-in lands.
 *
 * A page that sends a person to sign in (a link that needs a session before it can open) may
 * name the place to come back to as `?returnTo=<path>` on the login URL. The query string is the
 * keeper: the value survives a reload of the login page and the sign-in's own round trip without
 * any state the page would have to carry itself.
 *
 * The value is honoured ONLY as a same-origin path — the site's own address space, never a way
 * off it. The rule, in full:
 *  1. the value begins with `/` (a path, not a scheme or a host);
 *  2. resolved as a URL it stays on its origin (a protocol-relative `//host`, a `\`-slashed
 *     `/\host`, a control-character smuggled `/<tab>/host`, an absolute `https://host` and a
 *     `javascript:` value all resolve elsewhere);
 *  3. the RESOLVED path is not itself protocol-relative (`/..//host` resolves on-origin to the path
 *     `//host`, which a navigation would then read as a host).
 * Anything that fails the rule lands on `/` exactly as a sign-in with no return-to does. The landing
 * is the resolved path (pathname, search, hash) — the form the browser agreed is on-origin — never
 * the raw value.
 */
export class ReturnTo {
  /** The query parameter a page sets on the login URL to name where the sign-in should land. */
  static readonly PARAM = 'returnTo';
  /** The landing when nothing (safe) was asked for. */
  static readonly HOME = '/';
  /**
   * The origin the value is resolved against. Any fixed origin serves: the rule is that the value
   * does not LEAVE the origin it is resolved against, whatever that origin is.
   */
  private static readonly PROBE_ORIGIN = 'https://same-origin.invalid';

  /** The landing for a login page whose URL carries `search` (its `?…` query string). */
  static landing(search: string): string {
    const value = new URLSearchParams(search).get(ReturnTo.PARAM);
    if (value === null) {
      return ReturnTo.HOME;
    }

    return ReturnTo.safePath(value) ?? ReturnTo.HOME;
  }

  /** `value` as a same-origin path, or undefined when it is anything else. */
  private static safePath(value: string): string | undefined {
    if (!value.startsWith('/')) {
      return undefined;
    }

    let resolved: URL;
    try {
      resolved = new URL(value, ReturnTo.PROBE_ORIGIN);
    } catch {
      return undefined;
    }
    if (resolved.origin !== ReturnTo.PROBE_ORIGIN) {
      return undefined;
    }

    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return path.startsWith('//') ? undefined : path;
  }
}
