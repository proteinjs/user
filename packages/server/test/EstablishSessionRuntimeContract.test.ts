import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { establishSession } from '../src/authentication/establishSession';
import { createPassportRequest } from './passportSessionHarness';

/**
 * establishSession's post-condition: `request.login` must have REPLACED `request.session`
 * (express-session's regenerate always assigns a fresh Session object — the fresh sid the
 * commit-before-response save then writes under). Passport 0.6 honors that on every login;
 * a pre-0.6 passport runtime (@proteinjs/server < 3.5.1) resolves the login WITHOUT
 * regenerating or saving — silently reopening the session-fixation hole (CVE-2022-25896) AND
 * the first-hit race (the post-login navigation beating the deferred session write — the
 * /dev/login lands-on-login-form smoke finding, DEV_SMOKE_OVERNIGHT 2026-08-26 #7).
 *
 * The guard turns that silent degradation into a loud, seam-naming failure at the one owner of
 * session establishment. DevLoginStaleCookieFirstHit.test.ts proves the honored contract
 * through the real middleware stack; this suite pins the refusal when the runtime cannot honor
 * it.
 */
describe('establishSession runtime contract', () => {
  it('rejects, naming the seam, when login resolves without replacing the session (pre-0.6 passport shape)', async () => {
    const session: Record<string, unknown> = {};
    const request = {
      session,
      login(user: string, cb: (error?: unknown) => void) {
        // passport 0.4's SessionManager.logIn: bind onto the SAME session object, no
        // regenerate, no save — the stale-runtime shape the guard must refuse.
        session.passport = { user };
        cb();
      },
    };

    await expect(establishSession(request, 'dev@test.local')).rejects.toThrow(/@proteinjs\/server/);
  });

  it('resolves through the real passport 0.6 machinery, user bound on the post-regeneration session', async () => {
    const { request, events } = await createPassportRequest();

    await establishSession(request, 'dev@test.local');

    expect(request.session.passport.user).toBe('dev@test.local');
    expect(events).toEqual(['regenerate', 'login', 'save']);
  });

  it(`binds the address lowercased, as the account row holds it — the session row's userEmail is what every by-account session kill matches`, async () => {
    const { request } = await createPassportRequest();

    await establishSession(request, 'Mixed.Case@Test.local');

    expect(request.session.passport.user).toBe('mixed.case@test.local');
  });

  it('still surfaces a login failure as a rejection (never as the contract error)', async () => {
    const loginError = new Error('serialize blew up');
    const request = {
      session: {},
      login(_user: string, cb: (error?: unknown) => void) {
        cb(loginError);
      },
    };

    await expect(establishSession(request, 'dev@test.local')).rejects.toThrow('serialize blew up');
  });
});

/**
 * The session's other edge has one owner too: every by-account session end in this package rides
 * `AccountSessions` (a password reset or change, an address change, a deactivation, a machine
 * credential's rotation), so the one matching rule — the account row's address, exact — lives in
 * one place. Three sites once carried their own copy of the delete; a rule applied in four places
 * is a rule missed in one. A source fact, read off src as text.
 */
describe('the by-account session end has one owner', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).reduce<string[]>((files, name) => {
      const path = join(dir, name);
      return files.concat(statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []);
    }, []);

  it('every delete of session rows by address in src is AccountSessions’ own', () => {
    const src = join(__dirname, '..', 'src');
    const byAddress = sourceFiles(src).filter((file) =>
      /delete\(\s*tables\.Session\s*,\s*\{\s*userEmail/.test(readFileSync(file, 'utf8'))
    );
    expect(byAddress.map((file) => relative(src, file))).toEqual(['authentication/AccountSessions.ts']);
  });
});
