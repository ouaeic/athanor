import { describe, expect, it } from 'vitest';
import { taskReasoningEffort } from './reasoning.js';

describe('owner reasoning effort controls the request', () => {
  it('honors lower and higher owner choices despite automatic escalation', () => {
    expect(taskReasoningEffort('low', 'high', { mandatory: false, supportedEfforts: null })).toBe(
      'low'
    );
    expect(taskReasoningEffort('max', 'medium', { mandatory: false, supportedEfforts: null })).toBe(
      'max'
    );
    expect(taskReasoningEffort('none', 'high', { mandatory: false, supportedEfforts: null })).toBe(
      'none'
    );
  });
  it('keeps Auto adaptive while using only advertised choices', () => {
    expect(taskReasoningEffort('auto', 'high')).toBe('high');
    expect(taskReasoningEffort(undefined, 'medium')).toBe('medium');
    expect(
      taskReasoningEffort('auto', 'high', {
        mandatory: true,
        supportedEfforts: ['low', 'max'],
        defaultEffort: 'max'
      })
    ).toBe('max');
    expect(
      taskReasoningEffort('auto', 'high', { mandatory: false, supportedEfforts: [] })
    ).toBeUndefined();
  });
  it('refuses unknown model controls before a provider request', () => {
    expect(() => taskReasoningEffort('high', 'medium')).toThrow('no longer advertises');
  });
  it('does not silently change an explicit choice when model capabilities change', () => {
    expect(() =>
      taskReasoningEffort('low', 'high', { mandatory: true, supportedEfforts: ['high'] })
    ).toThrow('does not support');
  });
});
