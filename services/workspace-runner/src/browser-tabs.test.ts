import { describe, expect, it } from 'vitest';
import { AGENT_TAB_LIMIT, BrowserTabs, TAB_IDLE_MS } from './browser-tabs.js';

describe('browser resource retention', () => {
  it('expires idle temporary tabs while preserving every protected resource', () => {
    const tabs = new BrowserTabs();
    const ids = ['idle', 'recent', 'owner', 'pinned', 'active', 'download', 'dialog'];
    for (const id of ids) tabs.add(id, id === 'owner' ? 'user' : 'agent', 'task-a', 0);
    tabs.touch('recent', 'agent', TAB_IDLE_MS);
    tabs.pin('pinned', true);
    tabs.download('download', 1);
    tabs.dialog('dialog', true);
    const states = (holder: string) =>
      ids.map((id) => tabs.state(id, 'about:blank', id === 'active', holder));
    expect(tabs.candidates(states('agent'), TAB_IDLE_MS)).toEqual(['idle']);
    expect(tabs.candidates(states('user'), TAB_IDLE_MS * 2)).toEqual([]);
    expect(tabs.candidates(states('secure_input'), TAB_IDLE_MS * 2)).toEqual([]);
    tabs.download('download', -1);
    tabs.dialog('dialog', false);
    expect(tabs.candidates(states('agent'), TAB_IDLE_MS)).toEqual(['idle', 'download', 'dialog']);
  });

  it('makes room using the oldest eligible tab and does not count owner tabs against agent capacity', () => {
    const tabs = new BrowserTabs();
    const ids = Array.from({ length: AGENT_TAB_LIMIT }, (_, index) => `tab-${index}`);
    for (const [index, id] of ids.entries()) tabs.add(id, 'agent', 'task-a', index);
    tabs.add('owner', 'user', null, 0);
    tabs.pin('tab-0', true);
    const states = [...ids, 'owner'].map((id) =>
      tabs.state(id, 'about:blank', id === 'tab-1', 'agent')
    );
    expect(tabs.candidates(states, AGENT_TAB_LIMIT, false)).toEqual([]);
    expect(tabs.candidates(states, AGENT_TAB_LIMIT, true)).toEqual(['tab-2']);
    for (const id of ids) tabs.pin(id, true);
    expect(
      tabs.candidates(
        ids.map((id) => tabs.state(id, '', false, 'agent')),
        TAB_IDLE_MS * 2,
        true
      )
    ).toEqual([]);
  });

  it('does not let a late popup-opener lookup override actual owner interaction', () => {
    const tabs = new BrowserTabs();
    tabs.add('popup', 'user', null, 0);
    tabs.touch('popup', 'user', 1);
    tabs.adopt('popup', { owner: 'agent', taskId: 'task-a' });
    expect(tabs.state('popup', '', false, 'agent')).toMatchObject({
      owner: 'user',
      protectedReason: 'owner'
    });
    tabs.add('child', 'user', null, 0);
    tabs.adopt('child', { owner: 'agent', taskId: 'task-a' });
    expect(tabs.state('child', '', false, 'agent')).toMatchObject({
      owner: 'agent',
      taskId: 'task-a',
      protectedReason: null
    });
  });
});
