process.env.SPANNER_EMULATOR_HOST = process.env.SPANNER_EMULATOR_HOST || 'localhost:9010';
process.env.DB_LOG_LEVEL = 'error';
// The key the throttled doors' digests (RequestDigests) derive from; a process without one refuses to digest.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'user-server-test-secret';
