import { describe, expect, it } from 'vitest';
import { describeMediaControls, mediaArguments } from './media-controls.js';
import { approvalRequirement } from './approval-policy.js';

describe('on-demand media controls', () => {
  it('validates nested settings and keeps the approval quote aligned with dispatch', () => {
    const args = {
      kind: 'video',
      prompt: 'A quiet landscape',
      options: { modelId: 'video/model', duration: 8, maxCostUsd: 2 }
    };
    expect(mediaArguments(args)).toMatchObject({ kind: 'video', duration: 8, maxCostUsd: 2 });
    const approval = approvalRequirement('generate_media', args);
    expect(approval?.preview).toContain('8 second video');
    expect(approval?.preview).toContain('$2.00');
    expect(approval?.preview).toContain('Stopping local watching does not cancel');
  });
  it('refuses undeclared provider overrides and conflicting settings', () => {
    expect(() => mediaArguments({ options: { apiKey: 'new-key' } })).toThrow();
    expect(() => mediaArguments({ duration: 4, options: { duration: 8 } })).toThrow(/one value/);
    expect(() => mediaArguments({ options: { duration: -1 } })).toThrow();
    expect(mediaArguments({ outputFormat: 'png', options: { outputFormat: 'png' } })).toEqual({
      outputFormat: 'png'
    });
  });
  it('returns the runtime schema without adding it to every model request', () => {
    const schema = describeMediaControls().options;
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    expect(schema.properties).toHaveProperty('frameImages');
    expect(schema.properties).toHaveProperty('modelId');
    expect(schema.additionalProperties).toBe(false);
  });
});
