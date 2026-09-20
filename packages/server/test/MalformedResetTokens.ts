/**
 * The `token` field of a request that does not carry a well-formed reset token: every type a
 * parsed body or query string can deliver, and every near-miss of the token's shape. The
 * near-misses are cut from a LIVE token, so a shape check that loosens (a lost anchor, a wider
 * length, a case-insensitive class, a missing type check) would be looking up something derived
 * from a real credential — and the suites that use this table assert that no lookup is built.
 */
export class MalformedResetTokens {
  static readonly CASES: [label: string, tokenField: (liveToken: string) => Record<string, unknown>][] = [
    ['absent', () => ({})],
    ['undefined', () => ({ token: undefined })],
    ['null', () => ({ token: null })],
    ['empty', () => ({ token: '' })],
    ['a string of another shape', () => ({ token: 'tok-valid-1' })],
    ['a number', () => ({ token: 123 })],
    ['true', () => ({ token: true })],
    ['an array', () => ({ token: ['a', 'b'] })],
    ['an array holding the live token', (liveToken) => ({ token: [liveToken] })],
    ['an object', () => ({ token: { passwordResetToken: null } })],
    ['63 hex characters of the live token', (liveToken) => ({ token: liveToken.slice(0, 63) })],
    ['the live token and one more hex character', (liveToken) => ({ token: `${liveToken}a` })],
    ['the live token in uppercase hex', (liveToken) => ({ token: liveToken.toUpperCase() })],
    ['the live token and a trailing newline', (liveToken) => ({ token: `${liveToken}\n` })],
    ['the live token after a leading space', (liveToken) => ({ token: ` ${liveToken}` })],
    ['64 characters that are not hex', () => ({ token: 'g'.repeat(64) })],
  ];
}
