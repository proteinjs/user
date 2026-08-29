module.exports = {
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // One reflection copy per process — the globalThis-adopting singleton (reflection >=1.2.0)
  // must never adopt an instance minted by a second copy reached through a symlinked estate
  // (splits table/permission object selection — sessionTableAuth's admin break-glass refused).
  // Same pin user-server carries; CI's npm dedupe makes this a no-op there.
  moduleNameMapper: {
    '^@proteinjs/([^/]+)$': '<rootDir>/node_modules/@proteinjs/$1',
  },
  testEnvironment: 'node',
};
