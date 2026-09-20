import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lockFilePathFor } = require('./emulatorLock') as { lockFilePathFor: (host: string) => string };

/**
 * The emulator lock's FILE NAME is a contract between every copy of the lock: two jest runs
 * serialize on a shared emulator only when they compute the same file for the same host. No
 * shared package carries the lock yet, so the contract is pinned by value — this table is the
 * same, row for row, in every repository that keeps a copy. A change to a row here is a change
 * to all of them, made in the same window; a copy that drifts stops contending, silently.
 */
// [emulator host, lock file name, what the row pins]
const LOCK_FILE_NAMES: [string, string, string][] = [
  ['localhost:9010', 'spanner-emulator-localhost-9010-0091e79a.lock', 'the default shared emulator'],
  [
    'localhost-9010',
    'spanner-emulator-localhost-9010-493b66d1.lock',
    'the same slug as the row above: the hash alone keeps two hosts apart',
  ],
  [
    '[emulator.a-host-name-long-enough-to-run-past-the-sixty-four-cap.example.test]:9010',
    'spanner-emulator-emulator-a-host-name-long-enough-to-run-past-the-sixty-four-cap--fe958a1a.lock',
    'edge dashes trimmed first, the slug capped at 64 second (the cap lands on a dash, and it stays)',
  ],
];

describe('the emulator lock file name (the contract every copy of the lock shares)', () => {
  it.each(LOCK_FILE_NAMES)('%s locks on %s (%s)', (host, fileName) => {
    expect(lockFilePathFor(host)).toBe(path.join(os.tmpdir(), fileName));
  });
});
