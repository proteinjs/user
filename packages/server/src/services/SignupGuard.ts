import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * What the signup route hands the guard about a no-invite submission: request facts only the
 * route can read, reduced to what an abuse posture needs and never anything that identifies the
 * client on its own.
 */
export type SignupGuardFacts = {
  /** The address the form carries, trimmed and lowercased — the account's address if the signup goes through. */
  email: string;
  /**
   * The form's honeypot field (`website`) when the form carries one — a field no person sees, so
   * a value in it is bot-shaped. Undefined when the form has no such field.
   */
  honeypot?: string;
  /** The render-moment token the form carries, when it carries one — a consumer's time trap verifies it. */
  formToken?: string;
  /**
   * The coarse hash of the client's address (`RequestDigests.coarseIp` of the address `ClientAddress`
   * reads): the key a per-device window counts on and the name a log line gives a device. Never
   * the address itself.
   */
  clientDevice: string;
  /** Whether the request carried a User-Agent header at all. */
  hasUserAgent: boolean;
};

/**
 * The guard's answer, one of three:
 * - `allow` — the signup continues: the account is created and its session established;
 * - `refuse` — the route answers `{ error: sentence }` with no account and no session; the
 *   sentence is read by the person, so it is plain words in full;
 * - `drop` — the route answers exactly as it answers success (`{}`) with no account and no
 *   session, and the caller cannot tell: the silent drop for a bot-shaped submission, which gets
 *   nothing to iterate against.
 */
export type SignupGuardVerdict = { verdict: 'allow' } | { verdict: 'refuse'; sentence: string } | { verdict: 'drop' };

/**
 * The seam a consumer plugs its sign-up abuse posture into — a honeypot, a time trap, a
 * per-device throttle, a daily breaker, whatever it holds — by registering a class that
 * implements this interface (the `DefaultInviteConfigFactory` pattern; the first registration
 * found is the guard). The signup route consults it on the NO-INVITE road only: an invited
 * address was chosen by an admin, and the invite road is unchanged. With no registration every
 * submission is allowed.
 */
export interface DefaultSignupGuard extends Loadable {
  check(facts: SignupGuardFacts): SignupGuardVerdict | Promise<SignupGuardVerdict>;
}

export const getDefaultSignupGuard = (): DefaultSignupGuard => {
  const allowEvery: DefaultSignupGuard = {
    check: (): SignupGuardVerdict => ({ verdict: 'allow' }),
  };

  const guard = SourceRepository.get().object<DefaultSignupGuard>('@proteinjs/user-server/DefaultSignupGuard');
  return guard || allowEvery;
};
