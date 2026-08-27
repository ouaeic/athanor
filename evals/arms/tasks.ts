/**
 * The sample: the owner's own words, taken from the fixtures that already exist.
 *
 * Not new prompts. Seventy fixtures were written one at a time, each against a specific thing the
 * loop does, and their `request` fields are the closest thing this repository has to a corpus of
 * what an owner actually asks for. Writing a second corpus for this rig would mean two sets of
 * tasks drifting apart, and the newer one would be the one written by somebody who already had a
 * hypothesis about which arm should win.
 *
 * One shape is dropped. `schema` fixtures are not jobs - they are assertions about the catalogue
 * every other row is priced on - so handing one to a model as a request would score an arm on a
 * question about itself. Every other shape is kept, including `refusal`: an arm that gets a
 * refusal wrong is an arm with a real defect, and dropping the shapes an author expects to be
 * awkward is how a sample becomes an argument.
 */
import { fixtures } from '../fixtures.js';

export interface ArmTask {
  readonly id: string;
  readonly shape: string;
  /** The owner's words, exactly as the fixture states them. */
  readonly request: string;
}

const EXCLUDED_SHAPES = new Set(['schema']);

export const TASKS: readonly ArmTask[] = fixtures
  .filter((fixture) => !EXCLUDED_SHAPES.has(fixture.shape))
  .map((fixture) => ({ id: fixture.id, shape: fixture.shape, request: fixture.request }));

/**
 * A subset that keeps the shape mix, for a live run somebody is paying for out of their own
 * pocket. `--sample N` takes the first task of each shape, then the second of each, and so on, so
 * a small N is still spread across the shapes rather than being the first N ids alphabetically.
 */
export const sampleOf = (size: number): readonly ArmTask[] => {
  if (size >= TASKS.length) return TASKS;
  const byShape = new Map<string, ArmTask[]>();
  for (const task of TASKS) byShape.set(task.shape, [...(byShape.get(task.shape) ?? []), task]);
  const lanes = [...byShape.values()];
  const chosen: ArmTask[] = [];
  for (let round = 0; chosen.length < size; round += 1) {
    let took = false;
    for (const lane of lanes) {
      const task = lane[round];
      if (!task || chosen.length >= size) continue;
      chosen.push(task);
      took = true;
    }
    if (!took) break;
  }
  return chosen;
};
