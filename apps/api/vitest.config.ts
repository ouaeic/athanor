import { defineConfig } from 'vitest/config';

/**
 * Six of this package's suites stand up a whole PostgreSQL in WebAssembly, and the end-to-end one
 * also runs the real agent loop against it. That is deliberate - it is the only place a task is
 * driven from a prompt through to a finished turn against a real database - and it is expensive
 * enough that several at once, on a machine already running the other eleven packages' suites,
 * starve each other into their timeouts. A suite that passes alone and fails beside its siblings
 * reports a working behaviour as a defect, which is worse than being slow.
 *
 * The same reasoning as packages/data, for the same reason.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
