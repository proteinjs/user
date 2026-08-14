'use strict';
// Releases the emulator lock acquired by ./emulatorLock.globalSetup.js (same jest parent process).
require('./setup');
const { release } = require('./emulatorLock');

module.exports = async () => {
  release(process.env.SPANNER_EMULATOR_HOST, require('../package.json').name);
};
