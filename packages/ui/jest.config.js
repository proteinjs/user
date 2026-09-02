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
    // React (and MUI, which carries the theme context) must also be process singletons:
    // the @proteinjs/ui symlink resolves to a checkout whose nested react/@mui copies
    // escape npm dedupe in a symlinked estate — a second react nulls the hook dispatcher
    // (Table's useFormFactor was the first caller to trip it). Same CI-inert contract as
    // the @proteinjs pin above.
    '^react$': '<rootDir>/node_modules/react',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom/$1',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^@mui/material$': '<rootDir>/node_modules/@mui/material',
    '^@mui/material/(.*)$': '<rootDir>/node_modules/@mui/material/$1',
    '^@mui/system$': '<rootDir>/node_modules/@mui/system',
    '^@emotion/react$': '<rootDir>/node_modules/@emotion/react',
    '^react-router$': '<rootDir>/node_modules/react-router',
    '^react-router-dom$': '<rootDir>/node_modules/react-router-dom',
    '^@remix-run/router$': '<rootDir>/node_modules/@remix-run/router',
    '^react-query$': '<rootDir>/node_modules/react-query',
  },
  testEnvironment: 'node',
};
