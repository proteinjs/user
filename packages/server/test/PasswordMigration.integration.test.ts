import sha256 from 'crypto-js/sha256';
import * as argon2 from 'argon2';
import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { tables, User } from '@proteinjs/user';
import { authenticate } from '../src/authentication/authenticate';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { Signup } from '../src/services/Signup';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const testEnv = new UserServerTestEnvironment();

const ARGON2ID_PREFIX = '$argon2id$';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The sha256→argon2id migration: authentication queries by EMAIL ONLY and compares in code
 * (query-by-hash is dead), legacy sha256 rows upgrade in place on their next successful login
 * (verify-then-rehash), every password write produces only the new self-describing format, and
 * machine rows (generated 256-bit secrets) stay sha256 by design — cheap per-poll verifies.
 */
describe('Password KDF migration', () => {
  beforeAll(async () => {
    await testEnv.beforeAll();
  }, 120000);

  afterAll(async () => {
    await testEnv.afterAll();
  });

  beforeEach(async () => {
    await getDbAsSystem().delete(tables.User, {});
  });

  const insertUser = async (fields: Partial<User> & { email: string; password: string }) =>
    await getDbAsSystem().insert(tables.User, {
      name: 'Test user',
      emailVerified: true,
      roles: [],
      ...fields,
    });

  const userRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });

  it('legacy sha256 row: login succeeds and the row is upgraded in place to argon2id', async () => {
    const legacyHash = sha256('hunter2 was fine in 2004').toString();
    await insertUser({ email: 'legacy@test.local', password: legacyHash });

    expect(await authenticate('legacy@test.local', 'hunter2 was fine in 2004')).toBe(true);

    // Outcome: the stored value CHANGED, to the self-describing argon2id format, and still
    // matches the same credential (the encoded string carries its own per-user salt).
    const upgraded = (await userRow('legacy@test.local')).password;
    expect(upgraded).not.toBe(legacyHash);
    expect(upgraded.startsWith(ARGON2ID_PREFIX)).toBe(true);
    await expect(argon2.verify(upgraded, 'hunter2 was fine in 2004')).resolves.toBe(true);

    // The migrated row logs in through the argon2 leg — and is NOT rehashed again.
    expect(await authenticate('legacy@test.local', 'hunter2 was fine in 2004')).toBe(true);
    expect((await userRow('legacy@test.local')).password).toBe(upgraded);
  });

  it('new-format row: login verifies against the stored encoded hash', async () => {
    const encoded = await new PasswordHasher().hash('correct horse battery staple');
    await insertUser({ email: 'modern@test.local', password: encoded });

    expect(await authenticate('modern@test.local', 'correct horse battery staple')).toBe(true);
    expect((await userRow('modern@test.local')).password).toBe(encoded);
  });

  it('wrong password fails for both stored formats, and never mutates the row', async () => {
    const legacyHash = sha256('right password').toString();
    await insertUser({ email: 'legacy@test.local', password: legacyHash });
    await insertUser({ email: 'modern@test.local', password: await new PasswordHasher().hash('right password') });

    expect(await authenticate('legacy@test.local', 'wrong password')).toBe('User name or password incorrect');
    expect(await authenticate('modern@test.local', 'wrong password')).toBe('User name or password incorrect');

    // A failed attempt is not a migration event: the legacy row still holds its sha256.
    expect((await userRow('legacy@test.local')).password).toBe(legacyHash);
  });

  it('unknown email fails the same way (no query-by-hash oracle)', async () => {
    expect(await authenticate('nobody@test.local', 'anything')).toBe('User name or password incorrect');
  });

  it('new registrations write only the new format', async () => {
    await new Signup().createAccount({
      name: 'New user',
      email: 'new@test.local',
      password: 'first password',
      emailVerified: false,
      invitedBy: null,
    });

    const row = await userRow('new@test.local');
    expect(row.password.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(row.password).not.toBe(sha256('first password').toString());
    expect(await authenticate('new@test.local', 'first password')).toBe(true);
  });

  it('deactivated and pending-deletion gates are unchanged across both formats', async () => {
    // Staff-deactivated account: correct credentials are still refused a session.
    await insertUser({ email: 'off@test.local', password: sha256('pw').toString(), status: 'deactivated' });
    expect(await authenticate('off@test.local', 'pw')).toBe('This account has been deactivated');

    // Pending-deletion account (deactivated + deleteRequestedAt): login IS the cancel signal —
    // authenticate admits it, for migrated rows too.
    await insertUser({
      email: 'pending@test.local',
      password: await new PasswordHasher().hash('pw'),
      status: 'deactivated',
      deleteRequestedAt: moment(),
    });
    expect(await authenticate('pending@test.local', 'pw')).toBe(true);
  });

  it('machine rows authenticate through the same owner but never leave sha256', async () => {
    // The minted-credential shape: a generated 256-bit hex secret, sha256 at rest (stretching a
    // random 256-bit secret buys nothing, and the bridge logs in fresh per poll — see
    // PasswordHasher's machine mode).
    const secret = '9f'.repeat(32);
    const machineHash = sha256(secret).toString();
    await insertUser({ email: 'machine@test.local', password: machineHash, isLoadedFromSource: true });

    expect(await authenticate('machine@test.local', secret)).toBe(true);

    const row = await userRow('machine@test.local');
    expect(row.password).toBe(machineHash);
    expect(row.password).toMatch(SHA256_HEX);
  });
});
