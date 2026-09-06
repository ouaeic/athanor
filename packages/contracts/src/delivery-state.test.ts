import { describe, expect, it } from 'vitest';
import { mediaDeliveryState } from './delivery-state.js';

describe('durable media delivery state', () => {
  it('becomes ready only after the current output attempt completes', () => {
    expect(mediaDeliveryState([{ status: 'pending', outputPath: 'video.mp4' }]).summary).toEqual({
      status: 'pending',
      pendingJobs: 1,
      failedJobs: 0,
      completedJobs: 0
    });
    expect(
      mediaDeliveryState([
        { status: 'completed', outputPath: 'video.mp4' },
        { status: 'failed', outputPath: 'video.mp4' }
      ]).summary
    ).toEqual({ status: 'ready', pendingJobs: 0, failedJobs: 0, completedJobs: 1 });
    expect(
      mediaDeliveryState([{ status: 'submission_uncertain', outputPath: 'video.mp4' }]).summary
        .status
    ).toBe('incomplete');
  });
});
