import crypto from 'crypto';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lockFilePathFor } = require('./emulatorLock') as { lockFilePathFor: (host: string) => string };

/**
 * The lockfile path is a CONTRACT between every copy of the emulator lock: two jest runs only
 * serialize when they compute the same file for the same emulator host. The formula is pinned
 * here byte for byte — a neutral `spanner-emulator-` name (no application's name belongs in a
 * shared lock), the sanitized host slug, and the first 8 hex characters of the host's sha1.
 */
describe('emulatorLock.lockFilePathFor', () => {
  const expectedFor = (host: string, slug: string) =>
    path.join(
      os.tmpdir(),
      `spanner-emulator-${slug}-${crypto.createHash('sha1').update(host).digest('hex').slice(0, 8)}.lock`
    );

  it('names the lock by the emulator alone: spanner-emulator-<slug>-<sha1[0..8]>.lock in os.tmpdir()', () => {
    expect(lockFilePathFor('localhost:9010')).toBe(expectedFor('localhost:9010', 'localhost-9010'));
    expect(lockFilePathFor('127.0.0.1:9710')).toBe(expectedFor('127.0.0.1:9710', '127-0-0-1-9710'));
  });

  it('gives two emulators two files, and one emulator the same file every time', () => {
    expect(lockFilePathFor('localhost:9010')).toBe(lockFilePathFor('localhost:9010'));
    expect(lockFilePathFor('localhost:9010')).not.toBe(lockFilePathFor('localhost:9011'));
    // The hash keeps hosts apart even when their slugs collide.
    expect(lockFilePathFor('localhost:9010')).not.toBe(lockFilePathFor('localhost-9010'));
  });
});
