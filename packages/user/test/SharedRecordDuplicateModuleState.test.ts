/**
 * Duplicate-module-instance guard for the skip-access-grants toggle (task #36).
 *
 * Per-package installs can put two live copies of @proteinjs/user in one process (each sibling
 * package's nested node_modules hosts its own registry copy; Node resolves through symlinked
 * workspace packages to distinct real paths). A module-scoped toggle then splits per copy:
 * the 2026-08-14 incident had a test toggling one copy's skipAccessGrants while the AccessGrant
 * closures enforced from the other copy — the toggle was a silent no-op and a stranger's
 * lock-room join was acked ok.
 *
 * `jest.isolateModules` reproduces the split semantics exactly: each isolated registry gets its
 * own module instance with its own module scope, the same way two nested install paths do. The
 * guard asserts the toggle set through one live copy is observed by another live copy — which
 * only holds when the state is anchored on the process global, not in module scope.
 */

type SharedRecordModule = typeof import('../src/SharedRecord');

const loadIsolatedCopy = (): SharedRecordModule => {
  let copy: SharedRecordModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    copy = require('../src/SharedRecord');
  });

  if (!copy) {
    throw new Error('Failed to load an isolated copy of SharedRecord');
  }

  return copy;
};

describe('SharedRecord skip-access-grants state under duplicate module instances', () => {
  afterEach(() => {
    delete (globalThis as any).__proteinjs_user_skipAccessGrants;
  });

  test('a toggle set through one live copy is enforced by every other live copy', () => {
    const copyA = loadIsolatedCopy();
    const copyB = loadIsolatedCopy();
    expect(copyA).not.toBe(copyB); // two distinct module instances, as under per-package installs

    // The incident shape: the test toggles copy A, the enforcing closures live in copy B.
    copyA.setSkipAccessGrants(true);
    expect(copyB.skipAccessGrantsEnabled()).toBe(true);

    // And the reverse direction: resetting through B must reach A.
    copyB.setSkipAccessGrants(false);
    expect(copyA.skipAccessGrantsEnabled()).toBe(false);
  });

  test('a copy loaded after the toggle was set still observes it', () => {
    const copyA = loadIsolatedCopy();
    copyA.setSkipAccessGrants(true);

    const lateCopy = loadIsolatedCopy();
    expect(lateCopy.skipAccessGrantsEnabled()).toBe(true);
  });
});
