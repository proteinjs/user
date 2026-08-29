module.exports = {
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // One copy of each @proteinjs package per process — a second copy reached through a
  // symlinked estate splits module-level state (the reflection singleton, ReferenceCellValue's
  // name cache). Same pin user-server carries; CI's npm dedupe makes this a no-op there.
  moduleNameMapper: {
    '^@proteinjs/([^/]+)$': '<rootDir>/node_modules/@proteinjs/$1',
  },
  testEnvironment: 'node',
};
