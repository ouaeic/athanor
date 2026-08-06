import { describe, expect, it } from 'vitest';
import { contextNote, externalRead, provenanceReport, sourcesPhrase } from './provenance.js';
import type { TaskEvent } from './types.js';

const event = (sequence: number, kind: string, summary: string, payload?: unknown): TaskEvent =>
  ({
    id: `event-${sequence}`,
    taskId: 'task-1',
    sequence,
    kind,
    summary,
    ...(payload === undefined ? {} : { payload }),
    createdAt: '2026-08-01T09:00:00.000Z'
  }) as TaskEvent;

const crossing = (sequence: number, sources: string[], tool: string): TaskEvent =>
  event(sequence, 'warning', `Untrusted content entered this turn from ${sources.at(-1)}`, {
    taint: { level: 'untrusted', sources, sinceStep: 3 },
    tool
  });

const started = (sequence: number, tool: string): TaskEvent =>
  event(sequence, 'tool_started', `Running ${tool}`, { tool, toolCallId: `call-${sequence}` });

describe('recognising that a turn read something from outside', () => {
  it('reads the crossing out of the payload, not out of the wording', () => {
    expect(crossing(4, ['web page elsewhere.example'], 'parallel_web_read')).toBeDefined();
    expect(externalRead(crossing(4, ['web page elsewhere.example'], 'parallel_web_read'))).toEqual({
      origin: 'web page elsewhere.example',
      sources: ['web page elsewhere.example'],
      tool: 'parallel_web_read'
    });
    // The sentence can be rephrased in the worker without the marker disappearing.
    const reworded = event(4, 'warning', 'Something else entirely', {
      taint: { level: 'untrusted', sources: ['mail inbox'], sinceStep: 1 },
      tool: 'connector_action'
    });
    expect(externalRead(reworded)?.origin).toBe('mail inbox');
  });

  it('is not confused by an ordinary warning', () => {
    expect(externalRead(event(2, 'warning', 'A page would not load'))).toBeUndefined();
    expect(externalRead(event(2, 'error', 'Something failed', { taint: {} }))).toBeUndefined();
    expect(
      externalRead(event(2, 'warning', 'x', { taint: { level: 'clean', sources: [] } }))
    ).toBeUndefined();
  });
});

describe('what the owner is told about a conversation that read from outside', () => {
  it('says nothing at all about one that never did', () => {
    expect(provenanceReport([event(1, 'user_message', 'hello'), started(2, 'file_write')])).toBe(
      undefined
    );
    expect(provenanceReport([])).toBeUndefined();
  });

  it('lists every origin once, in the order they were first read', () => {
    const report = provenanceReport([
      crossing(3, ['web page a.example'], 'parallel_web_read'),
      crossing(6, ['web page a.example', 'mail inbox'], 'connector_action'),
      crossing(9, ['web page a.example', 'mail inbox'], 'connector_action')
    ]);
    expect(report?.sources).toEqual(['web page a.example', 'mail inbox']);
    expect(report?.sinceSequence).toBe(3);
  });

  it('counts what changed afterwards, and only what changed', () => {
    const report = provenanceReport([
      started(1, 'file_write'),
      crossing(2, ['web page a.example'], 'parallel_web_read'),
      started(3, 'parallel_web_read'),
      started(4, 'file_read'),
      started(5, 'file_write'),
      started(6, 'file_write'),
      started(7, 'publish_site')
    ]);
    expect(report?.changes).toEqual([
      { label: 'Wrote a file', count: 2 },
      { label: 'Published to the public internet', count: 1 }
    ]);
  });

  it('does not count the writes that happened before the reading did', () => {
    const report = provenanceReport([
      started(1, 'file_write'),
      started(2, 'publish_site'),
      crossing(3, ['web page a.example'], 'parallel_web_read')
    ]);
    expect(report?.changes).toEqual([]);
  });

  it('can honestly say that nothing followed, which is the common case', () => {
    const report = provenanceReport([
      crossing(2, ['web search results'], 'web_search'),
      started(3, 'parallel_web_read'),
      started(4, 'document_read')
    ]);
    expect(report?.changes).toEqual([]);
  });
});

describe('saying where it came from', () => {
  it('folds a long list rather than filling the line', () => {
    expect(sourcesPhrase(['a', 'b'])).toBe('a, b');
    expect(sourcesPhrase(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(sourcesPhrase([])).toBe('outside this computer');
  });
});

describe('what somebody about to answer an approval is told', () => {
  it('names where the conversation has read from, and who that makes the asker', () => {
    const note = contextNote([
      event(1, 'user_message', 'Summarise this'),
      crossing(2, ['web page news.example'], 'browser_action'),
      started(3, 'file_write')
    ]);
    expect(note.exposed).toBe(true);
    expect(note.text).toContain('web page news.example');
    expect(note.text).toContain('could be the one asking for this');
  });

  it('answers the other way round too, rather than falling silent', () => {
    // Silence is the failure mode this exists to avoid: on a card, a row that appears only when
    // something is wrong trains its own absence to mean that nothing is.
    const note = contextNote([
      event(1, 'user_message', 'Rename the file'),
      started(2, 'file_patch')
    ]);
    expect(note.exposed).toBe(false);
    expect(note.text).toBe('Nothing from outside this computer has entered this conversation.');
  });

  it('stays true of the whole conversation, not only the turn that read', () => {
    // Untrusted text does not leave the context at the end of the turn that read it, so an
    // approval three turns later is not a safer approval and must not be described as one.
    const note = contextNote([
      crossing(2, ['mail inbox'], 'connector_action'),
      event(3, 'assistant_message', 'Here is the summary'),
      event(4, 'user_message', 'Now send it'),
      started(5, 'connector_action')
    ]);
    expect(note.exposed).toBe(true);
    expect(note.text).toContain('mail inbox');
  });
});
