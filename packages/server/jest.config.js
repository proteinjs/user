module.exports = {
  roots: ['<rootDir>/test'],
  setupFiles: ['<rootDir>/test/setup.js'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testEnvironment: 'node',
  testTimeout: 60000,
  setupFiles: ['./test/setup'],
  globalSetup: './test/emulatorLock.globalSetup.js',
  globalTeardown: './test/emulatorLock.globalTeardown.js',
};
