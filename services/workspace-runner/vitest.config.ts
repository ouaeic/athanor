import { defineConfig } from 'vitest/config';

/**
 * These tests spawn real processes: the document toolchain runs converters, the execution tests
 * drive the sandbox helper, and the process manager starts and reaps background commands under
 * resource limits. Run several such files at once, on a machine already running the other eleven
 * packages' suites, and they contend for CPU and process slots badly enough that a command which
 * finishes comfortably on its own exceeds its limit and the test reports a defect that is not
 * there. Three of them failed that way on every full run and passed alone every time, which is the
 * worst shape a test can have - it teaches you to disbelieve a red suite.
 *
 * Running this package's files one after another costs a few seconds and removes the whole class,
 * exactly as `packages/data` already does for its database tests.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    // Generous rather than tight: a slow machine should make these slow rather than red.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
