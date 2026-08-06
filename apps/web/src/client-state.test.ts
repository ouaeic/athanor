import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DRAFT_LENGTH,
  clearDraft,
  pruneDrafts,
  readDraft,
  readInspectorChoice,
  readModelChoice,
  writeDraft,
  writeInspectorChoice,
  writeModelChoice
} from './client-state.js';

class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  failWrites = false;

  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('QuotaExceededError');
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('composer drafts', () => {
  it('scopes a draft to the conversation it was typed against', () => {
    writeDraft('task-a', 'half a paragraph about the invoice');
    writeDraft('task-b', 'something else entirely');

    expect(readDraft('task-a')).toBe('half a paragraph about the invoice');
    expect(readDraft('task-b')).toBe('something else entirely');
    // The new-conversation box is its own scope, never a fallback for an open conversation.
    expect(readDraft(undefined)).toBe('');
  });

  it('clears the draft rather than storing an empty string', () => {
    writeDraft('task-a', 'typed');
    writeDraft('task-a', '');
    expect(storage.getItem('athanor:draft:task-a')).toBeNull();

    writeDraft('task-a', 'typed again');
    clearDraft('task-a');
    expect(readDraft('task-a')).toBe('');
  });

  it('bounds a draft at the prompt ceiling the API enforces', () => {
    writeDraft(undefined, 'x'.repeat(MAX_DRAFT_LENGTH + 5_000));
    expect(readDraft(undefined)).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it('prunes drafts for conversations this device can no longer open', () => {
    writeDraft('task-a', 'still open');
    writeDraft('task-gone', 'deleted conversation');
    writeDraft(undefined, 'new conversation draft');

    pruneDrafts(['task-a']);

    expect(readDraft('task-a')).toBe('still open');
    expect(readDraft('task-gone')).toBe('');
    // The new-conversation draft belongs to no task and must survive every prune.
    expect(readDraft(undefined)).toBe('new conversation draft');
  });

  it('leaves keys that are not drafts alone', () => {
    storage.setItem('athanor:model', '{"automatic":true,"preference":"best","modelId":"m"}');
    pruneDrafts([]);
    expect(readModelChoice()).toEqual({ automatic: true, preference: 'best', modelId: 'm' });
  });
});

describe('remembered choices', () => {
  it('restores the model the owner deliberately picked', () => {
    writeModelChoice({ automatic: false, preference: 'best', modelId: 'openrouter/some-model' });
    expect(readModelChoice()).toEqual({
      automatic: false,
      preference: 'best',
      modelId: 'openrouter/some-model'
    });
  });

  it('restores the tools pane and the tab it was on', () => {
    writeInspectorChoice({ open: true, tab: 'terminal' });
    expect(readInspectorChoice()).toEqual({ open: true, tab: 'terminal' });
  });

  it('sends a device that had a retired pane open to the surface that inherited it', () => {
    storage.setItem('athanor:inspector', '{"open":true,"tab":"browser"}');
    expect(readInspectorChoice()).toEqual({ open: true, tab: 'computer' });
    storage.setItem('athanor:inspector', '{"open":true,"tab":"studio"}');
    expect(readInspectorChoice()).toEqual({ open: true, tab: 'files' });
    storage.setItem('athanor:inspector', '{"open":false,"tab":"usage"}');
    expect(readInspectorChoice()).toEqual({ open: false, tab: 'files' });
  });

  it('ignores stored values it cannot trust', () => {
    storage.setItem('athanor:model', 'not json');
    expect(readModelChoice()).toBeUndefined();
    storage.setItem('athanor:model', '{"automatic":true,"preference":"turbo"}');
    expect(readModelChoice()).toBeUndefined();
    storage.setItem('athanor:inspector', '{"open":true,"tab":"nowhere"}');
    expect(readInspectorChoice()).toBeUndefined();
  });

  it('reports nothing stored rather than throwing when the device refuses storage', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(readDraft('task-a')).toBe('');
    expect(readModelChoice()).toBeUndefined();
    expect(readInspectorChoice()).toBeUndefined();
    expect(() => writeDraft('task-a', 'typed')).not.toThrow();
    expect(() => pruneDrafts(['task-a'])).not.toThrow();
  });

  it('keeps working when the store accepts reads but refuses writes', () => {
    storage.failWrites = true;
    expect(() => writeDraft('task-a', 'typed')).not.toThrow();
    expect(() =>
      writeModelChoice({ automatic: true, preference: 'fast', modelId: '' })
    ).not.toThrow();
    expect(readDraft('task-a')).toBe('');
  });
});
