import { defineConfig } from 'vitest/config';

/**
 * Both test files in this package stand up a whole PostgreSQL in WebAssembly and replay every
 * migration against it, which is the point - it is the only place the migrations are exercised
 * against data rather than against an empty database. It is also expensive enough that two of them
 * at once, on a machine already running the other eleven packages' suites, starve each other:
 * a test that takes 0.8 seconds alone has been measured at 67 seconds beside its sibling, which is
 * long enough to trip a timeout and report a passing behaviour as a failure.
 *
 * Running this package's files one after another costs a few seconds and removes a whole class of
 * failure that looks like a defect and is not.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    // Generous rather than tight: these are database tests, and a slow machine should make them
    // slow rather than red.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
