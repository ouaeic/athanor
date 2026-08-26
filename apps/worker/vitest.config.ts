import { defineConfig } from 'vitest/config';

/**
 * This package ran with no test-runner configuration at all, which left every file on vitest's five
 * second default while two of them are nothing like a unit test. `agent-run.test.ts` drives the
 * whole agent loop - model stream, tool dispatch, checkpoints - and `memory-runtime.test.ts` stands
 * up a PostgreSQL in WebAssembly and replays every migration before each of its eleven store-backed
 * cases. Measured here with the rest of the monorepo's suites running beside it: those two files
 * account for 17.9 of the 19.4 seconds this package spends in tests, and the slowest single case
 * ends at 3.0 seconds against that five second ceiling. Two seconds of margin is not a passing
 * test, it is a test waiting for a loaded machine.
 *
 * The answer so far was eleven timeouts hand-written onto individual `it()` calls in
 * `agent-run.test.ts`, which covers the eleven that were noticed and leaves the next one to be
 * found by a red run nobody believes. Both halves of that belong in one place, here, so that a case
 * added tomorrow inherits them.
 */
export default defineConfig({
  test: {
    /*
     * The agent-loop file and the migrated-store file are the two expensive ones, and they are
     * exactly the two that get scheduled together: run at once, on a machine already running the
     * other eleven packages' suites, they contend for CPU badly enough that a case which finishes
     * comfortably alone can reach its ceiling. `packages/data`, `apps/api` and
     * `services/workspace-runner` each settled the same contention the same way. Measured over
     * three runs each way it costs this package about eleven seconds of wall clock (13.8 s to
     * 24.5 s) and gives back about two seconds of it inside the tests themselves (21.5 s to
     * 19.7 s), which is the contention being removed rather than merely deferred.
     */
    fileParallelism: false,
    /*
     * Ten times the slowest measured case (3.1 s), and above the twenty seconds the largest of the
     * deleted hand-written timeouts asked for, so nothing that used to be allowed is now refused.
     * Generous rather than tight: a slow machine should make these slow rather than red.
     */
    testTimeout: 30_000,
    // The store-backed cases build their database in `beforeEach`, so the hooks want the same room.
    hookTimeout: 30_000
  }
});
