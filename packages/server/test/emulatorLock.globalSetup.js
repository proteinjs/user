'use strict';
// jest runs this in the main jest process before any test workers (and before setupFiles), so one
// whole `jest --runInBand` run holds the emulator exclusively — concurrent suites from other
// packages wait instead of corrupting each other. globalSetup runs before setupFiles, so require
// ./setup here to compute the same SPANNER_EMULATOR_HOST the tests will use.
require('./setup');
const { acquire } = require('./emulatorLock');

module.exports = async () => {
  await acquire(process.env.SPANNER_EMULATOR_HOST, require('../package.json').name);
};
