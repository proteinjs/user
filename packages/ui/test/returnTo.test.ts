import { ReturnTo } from '../src/auth/ReturnTo';

/**
 * The same-origin rule in full, over the query string as the login page reads it: a path that
 * begins with `/` and stays on its origin when resolved is the landing (in its resolved form);
 * everything else — and no value at all — is home.
 */
describe('ReturnTo.landing', () => {
  it('honours a same-origin path, keeping its query and hash', () => {
    expect(ReturnTo.landing('?returnTo=%2Fdocument%3Fid%3D42%26invite%3Dabc')).toBe('/document?id=42&invite=abc');
    expect(ReturnTo.landing('?returnTo=%2Fa%2Fb%23section')).toBe('/a/b#section');
    expect(ReturnTo.landing('?returnTo=%2F')).toBe('/');
    // Other parameters beside it do not matter, in either order.
    expect(ReturnTo.landing('?x=1&returnTo=%2Fdocument&y=2')).toBe('/document');
  });

  it('lands the resolved path, never the raw value', () => {
    // A space is not a URL character; the browser would resolve it — the landing already has.
    expect(ReturnTo.landing('?returnTo=%2Fa%20b%3Fq%3Dc%20d')).toBe('/a%20b?q=c%20d');
    // An encoded slash pair stays a path segment on this origin — it is not a host.
    expect(ReturnTo.landing('?returnTo=%2F%252F%252Fevil.example')).toBe('/%2F%2Fevil.example');
  });

  it.each([
    ['an absolute https URL', 'https://evil.example/steal'],
    ['an absolute http URL', 'http://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a backslash-slashed host', '/\\evil.example/steal'],
    ['a tab smuggled before the host', '/\t/evil.example/steal'],
    ['a newline smuggled before the host', '/\n/evil.example/steal'],
    ['a dot-dot that resolves to a protocol-relative path', '/..//evil.example/steal'],
    ['a javascript: value', 'javascript:alert(1)'],
    ['a data: value', 'data:text/html,hi'],
    ['a scheme-less host', 'evil.example/steal'],
    ['a bare relative path', 'document?id=42'],
    ['an empty value', ''],
  ])('refuses %s and lands on home', (_case, value) => {
    expect(ReturnTo.landing(`?${ReturnTo.PARAM}=${encodeURIComponent(value)}`)).toBe(ReturnTo.HOME);
  });

  it('with no returnTo at all lands on home', () => {
    expect(ReturnTo.landing('')).toBe('/');
    expect(ReturnTo.landing('?other=1')).toBe('/');
  });
});
