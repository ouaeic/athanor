import { describe, expect, it } from 'vitest';
import { nativeTarget } from './native.js';

const id = '11111111-2222-4333-8444-555555555555';

describe('what a deep link opens', () => {
  it('opens the conversation or the computer it names', () => {
    expect(nativeTarget(`athanor://task/${id}`)).toEqual({ kind: 'task', id });
    expect(nativeTarget(`athanor://workspace/${id}`)).toEqual({ kind: 'workspace', id });
  });

  /*
   * A deep link comes from outside the app, so it is checked the way an address is: anything that
   * is not this scheme, one of these two destinations and an id shaped like the ones this box
   * issues opens nothing, rather than being sent to the API as a conversation id.
   */
  it('refuses anything that is not an athanor link', () => {
    expect(nativeTarget(`https://example.com/task/${id}`)).toBeUndefined();
    expect(nativeTarget(`athanor://settings/${id}`)).toBeUndefined();
    expect(nativeTarget('athanor://task/../../etc/passwd')).toBeUndefined();
    expect(nativeTarget('athanor://task')).toBeUndefined();
    expect(nativeTarget('not a url at all')).toBeUndefined();
    expect(nativeTarget('')).toBeUndefined();
  });

  it('refuses an id that is only shaped a little like one', () => {
    expect(nativeTarget('athanor://task/11111111-----------------------')).toBeUndefined();
    expect(nativeTarget(`athanor://task/${id}extra`)).toBeUndefined();
    expect(nativeTarget('athanor://task/11111111-2222-4333-8444')).toBeUndefined();
  });

  it('accepts an id however it was cased', () => {
    expect(nativeTarget(`athanor://task/${id.toUpperCase()}`)).toEqual({
      kind: 'task',
      id: id.toUpperCase()
    });
  });
});
