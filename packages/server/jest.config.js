module.exports = {
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // ESTATE-ONLY (r5asm): one reflection copy per process — the globalThis-adopting singleton
  // (reflection >=1.2.0) must never adopt an instance minted by an older copy reached through
  // the mixed farm estate. CI's npm dedupe makes this a no-op there.
  moduleNameMapper: {
    '^@proteinjs/([^/]+)$': '<rootDir>/node_modules/@proteinjs/$1',
    '^@proteinjs/([^/]+)/test$': '<rootDir>/node_modules/@proteinjs/$1/test',
  },
  testEnvironment: 'node',
  testTimeout: 60000,
  setupFiles: ['./test/setup'],
  globalSetup: './test/emulatorLock.globalSetup.js',
  globalTeardown: './test/emulatorLock.globalTeardown.js',
};
