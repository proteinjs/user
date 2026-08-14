'use strict';
/**
 * Cross-process mutual exclusion around a Spanner emulator.
 *
 * `--runInBand` serializes tests within one package; nothing serializes across packages, and two
 * jest runs hitting the same emulator corrupt each other (orphaned transactions, DDL
 * FAILED_PRECONDITION). This lock closes that gap for this package: a lockfile in os.tmpdir()
 * keyed by the emulator host string, held for the whole jest run via globalSetup/globalTeardown.
 *
 * The lockfile PATH FORMULA must stay byte-identical to the fleet's canonical implementation
 * (`EmulatorLock.lockFilePathFor` in @n3xah/thought-common/test) so suites from every repo
 * pointed at the same emulator actually contend on the same file. The logic is duplicated here
 * because this repo sits BELOW @n3xah in the dependency layering (thought-common itself depends
 * on @proteinjs/user) — future extraction target: @proteinjs/db-driver-spanner/test, beside
 * SpannerEmulatorProvisioner.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLL_MS = 1000;
const WAIT_LOG_EVERY_MS = 30_000;
const TIMEOUT_MS = 60 * 60_000; // full DB suites elsewhere legitimately run 30+ minutes

/** Deterministic lockfile path for an emulator host — sanitized slug plus short hash. */
function lockFilePathFor(host) {
  const slug = host
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const hash = crypto.createHash('sha1').update(host).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `n3xa-spanner-emulator-${slug}-${hash}.lock`);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive but not ours; ESRCH = gone
  }
}

function tryCreate(lockFilePath, packageName) {
  const info = {
    pid: process.pid,
    packageName,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  try {
    fs.writeFileSync(lockFilePath, JSON.stringify(info), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function readLockInfo(lockFilePath) {
  try {
    return JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
  } catch {
    return undefined; // gone, or unparseable (treated as stale)
  }
}

async function acquire(host, packageName) {
  const lockFilePath = lockFilePathFor(host);
  const start = Date.now();
  let lastWaitLog = 0;
  for (;;) {
    if (tryCreate(lockFilePath, packageName)) {
      return;
    }
    const info = readLockInfo(lockFilePath);
    if (!info || !isPidAlive(info.pid)) {
      // Stale (crashed run) — remove and retry; the O_EXCL create above decides the winner.
      try {
        fs.unlinkSync(lockFilePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    } else {
      const now = Date.now();
      if (now - start >= TIMEOUT_MS) {
        throw new Error(
          `timed out waiting for emulator lock (${host}) held by pid ${info.pid} (${info.packageName}); ` +
            `lockfile: ${lockFilePath}`
        );
      }
      if (lastWaitLog === 0 || now - lastWaitLog >= WAIT_LOG_EVERY_MS) {
        console.log(
          `[${packageName}] waiting for emulator lock (${host}) held by pid ${info.pid} ` +
            `(${info.packageName}, since ${info.timestamp}) — waited ${Math.round((now - start) / 1000)}s`
        );
        lastWaitLog = now;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function release(host, packageName) {
  const lockFilePath = lockFilePathFor(host);
  const info = readLockInfo(lockFilePath);
  if (!info) {
    console.log(`[${packageName}] emulator lock (${host}) was already gone at release`);
    return;
  }
  if (info.pid !== process.pid) {
    throw new Error(
      `refusing to release emulator lock (${host}) owned by pid ${info.pid} (${info.packageName}), not us (${process.pid})`
    );
  }
  fs.unlinkSync(lockFilePath);
}

module.exports = { acquire, release, lockFilePathFor };
