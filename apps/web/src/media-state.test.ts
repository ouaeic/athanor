import { describe, expect, it } from 'vitest';
import { mediaRouteIsRetired, mergeMediaPoll } from './media-state';
describe('media lifecycle presentation', () => {
  it('disables retired routes at their boundary without retiring unrelated models', () => {
    const route = { retirementAt: '2026-09-24T00:00:00.000Z' },
      end = Date.parse(route.retirementAt);
    expect(mediaRouteIsRetired(route, end - 1)).toBe(false);
    expect(mediaRouteIsRetired(route, end)).toBe(true);
    expect(mediaRouteIsRetired({}, end)).toBe(false);
  });
  it('preserves a newer action receipt while accepting newer provider progress', () => {
    const saved = { id: 'a', updatedAt: '2026-09-06T10:00:02Z', state: 'cancellation requested' };
    expect(
      mergeMediaPoll([saved], [{ ...saved, updatedAt: '2026-09-06T10:00:01Z', state: 'pending' }])
    ).toEqual([saved]);
    const fresh = { ...saved, updatedAt: '2026-09-06T10:00:03Z', state: 'cancelled' };
    expect(mergeMediaPoll([saved], [fresh])).toEqual([fresh]);
  });
});
