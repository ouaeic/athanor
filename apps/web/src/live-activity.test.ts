import { describe, expect, it } from 'vitest';
import { QUIET_AFTER_MS, liveActivity } from './live-activity.js';
import type { TaskEvent } from './types.js';

const START = Date.parse('2026-08-11T09:00:00.000Z');

let sequence = 0;
const at = (
  kind: TaskEvent['kind'],
  offsetMs: number,
  extra: Partial<TaskEvent> = {}
): TaskEvent => ({
  id: `event-${(sequence += 1)}`,
  taskId: 'task-1',
  sequence,
  kind,
  summary: kind,
  createdAt: new Date(START + offsetMs).toISOString(),
  ...extra
});

describe('live activity', () => {
  it('says nothing while a turn is behaving', () => {
    const events = [
      at('user_message', 0),
      at('tool_started', 1_000, { payload: { tool: 'shell' } })
    ];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 4_000 })).toBe('');
    // And nothing at the boundary either: the clock earns its place, it is not handed it.
    expect(
      liveActivity({ events, taskStatus: 'running', now: START + 1_000 + QUIET_AFTER_MS - 1 })
    ).toBe('');
  });

  it('names the tool that has not come back, and how long it has been gone', () => {
    const events = [
      at('user_message', 0),
      at('tool_started', 1_000, { payload: { tool: 'shell' } })
    ];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 181_000 })).toBe(
      'Running a command · 3m'
    );
  });

  it('stops counting the moment the tool returns', () => {
    const events = [
      at('user_message', 0),
      at('tool_started', 1_000, { payload: { tool: 'shell', toolCallId: 'call-1' } }),
      at('tool_result', 180_000, { payload: { toolCallId: 'call-1' } })
    ];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 181_000 })).toBe('');
  });

  it('counts from the last billed call when no tool is out', () => {
    // The measured failure: eleven minutes of streamed frames between two model calls, with a
    // spinner and a frozen cost as the only thing on screen.
    const events = [
      at('user_message', 0),
      at('cost', 60_000),
      ...Array.from({ length: 23 }, (_, index) => at('assistant_delta', 61_000 + index * 1_000))
    ];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 720_000 })).toBe(
      'Thinking · 11m'
    );
  });

  it('does not let a streamed frame reset the clock', () => {
    // A delta every 160 characters would otherwise report a spiral as one second old.
    const events = [at('user_message', 0), at('cost', 1_000), at('assistant_delta', 400_000)];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 401_000 })).toBe(
      'Thinking · 6m'
    );
  });

  it('counts the first call of a turn from the message that asked for it', () => {
    // The newest completion is the previous turn's `cost`, hours back, when the owner replied the
    // next morning. Their own message is a completion too, which is what keeps the number true.
    const events = [
      at('cost', 0),
      at('completed', 1_000),
      at('user_message', 43_200_000),
      at('assistant_reasoning', 43_260_000)
    ];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 43_320_000 })).toBe(
      'Thinking · 2m'
    );
  });

  it('holds an hour in two units', () => {
    const events = [at('user_message', 0), at('tool_started', 0, { payload: { tool: 'shell' } })];
    expect(liveActivity({ events, taskStatus: 'running', now: START + 3_900_000 })).toBe(
      'Running a command · 1h 05m'
    );
  });

  it('counts nobody who is not the machine', () => {
    const events = [at('user_message', 0), at('approval_requested', 1_000)];
    for (const taskStatus of ['awaiting_user', 'awaiting_resource', 'paused', 'completed'])
      expect(liveActivity({ events, taskStatus, now: START + 600_000 })).toBe('');
  });

  it('has nothing to count on an empty conversation', () => {
    expect(liveActivity({ events: [], taskStatus: 'queued', now: START })).toBe('');
  });
});
