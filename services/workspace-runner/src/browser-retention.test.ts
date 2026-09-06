import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager, type BrowserStreamState } from './browser.js';
import { AGENT_TAB_LIMIT, TAB_IDLE_MS } from './browser-tabs.js';

const driver = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));
vi.mock('./playwright.js', () => ({ chromiumDriver: () => Promise.resolve(driver) }));

class Page extends EventEmitter {
  closed = false;
  readonly url = vi.fn(() => 'about:blank');
  readonly title = vi.fn(async () => 'A page');
  readonly locator = vi.fn(() => ({ innerText: async () => '' }));
  readonly frames = vi.fn(() => []);
  readonly isClosed = () => this.closed;
  readonly evaluate = vi.fn(async () => []);
  readonly screenshot = vi.fn(async () => Buffer.from('frame'));
  readonly opener = vi.fn(async (): Promise<Page | null> => null);
  readonly bringToFront = vi.fn(async () => {});
  readonly keyboard = { up: vi.fn(async () => {}) };
  readonly mouse = { up: vi.fn(async () => {}) };
  readonly close = vi.fn(async () => {
    this.closed = true;
    this.emit('close');
  });
}

class Context extends EventEmitter {
  readonly all = [new Page()];
  readonly pages = () => this.all.filter((page) => !page.closed);
  readonly close = async () => {
    this.emit('close');
  };
  readonly newPage = async () => {
    const page = new Page();
    this.all.push(page);
    this.emit('page', page);
    return page;
  };
}

const cleanups: Array<() => Promise<void>> = [];
const workspaceId = 'browser-retention';
const setup = async () => {
  let now = 0;
  const root = await mkdtemp(path.join(tmpdir(), 'garden-tabs-'));
  const context = new Context();
  driver.launchPersistentContext.mockResolvedValue(context);
  const manager = new BrowserManager({ maxFileBytes: 100_000, now: () => now });
  const session = await manager.ensure(workspaceId, root);
  const states: BrowserStreamState[] = [];
  const cdp = { send: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  session.stream = {
    cdp: cdp as never,
    subscribers: new Set([{ state: (state) => states.push(state), frame: () => {} }])
  };
  cleanups.push(async () => {
    await manager.close(workspaceId);
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const result = await manager.act(
      workspaceId,
      root,
      { type: 'new_tab', activate: false },
      'agent',
      false,
      'task-a'
    );
    if (!('tabId' in result) || !result.tabId) throw new Error('Missing new tab identity');
    return result.tabId;
  };
  return {
    manager,
    root,
    context,
    session,
    states,
    open,
    advance: () => {
      now += TAB_IDLE_MS;
    }
  };
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  driver.launchPersistentContext.mockReset();
});

describe('live tab lifecycle', () => {
  it('publishes new, renamed, pinned and closed tabs directly on the owner stream', async () => {
    const { manager, root, context, states, open, advance } = await setup();
    const id = await open();
    expect(states.at(-1)?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tabId: id, owner: 'agent', taskId: 'task-a', title: 'A page' })
      ])
    );
    context.all[1]!.title.mockResolvedValue('Analysis results');
    context.all[1]!.emit('load');
    await vi.waitFor(() =>
      expect(states.at(-1)?.tabs.find((tab) => tab.tabId === id)?.title).toBe('Analysis results')
    );
    await manager.retainTab(workspaceId, root, id, true);
    advance();
    expect(await manager.sweepTabs(workspaceId)).toEqual([]);
    await manager.retainTab(workspaceId, root, id, false);
    expect(await manager.sweepTabs(workspaceId)).toEqual([id]);
    expect(states.at(-1)?.tabs.map((tab) => tab.tabId)).not.toContain(id);
    expect(states.at(-1)?.cleanup.closed).toBe(1);
    expect(context.all[0]!.close).not.toHaveBeenCalled();
  });

  it('bounds agent-created background tabs without requiring model cleanup calls', async () => {
    const { context, states, open } = await setup();
    const first = await open();
    for (let index = 1; index <= AGENT_TAB_LIMIT; index += 1) await open();
    expect(context.pages()).toHaveLength(AGENT_TAB_LIMIT + 1);
    expect(states.at(-1)?.tabs.map((tab) => tab.tabId)).not.toContain(first);
    expect(states.at(-1)?.tabs.filter((tab) => tab.owner === 'agent')).toHaveLength(
      AGENT_TAB_LIMIT
    );
    expect(context.all[0]!.close).not.toHaveBeenCalled();
  });

  it('preserves inactive temporary tabs throughout owner and private control', async () => {
    const { manager, session, context, open, advance } = await setup();
    const id = await open();
    advance();
    await session.control.transfer('user');
    expect(await manager.sweepTabs(workspaceId)).toEqual([]);
    await session.control.transfer('secure_input');
    expect(await manager.sweepTabs(workspaceId)).toEqual([]);
    expect(context.all[1]!.close).not.toHaveBeenCalled();
    await session.control.transfer('agent');
    expect(await manager.sweepTabs(workspaceId)).toEqual([id]);
  });

  it('inherits popup ownership from its opener while owner-created pages remain retained', async () => {
    const { manager, context, states, open, advance } = await setup();
    await open();
    const popup = new Page();
    popup.opener.mockResolvedValue(context.all[1]!);
    context.all.push(popup);
    context.emit('page', popup);
    const ownerPage = await context.newPage();
    await vi.waitFor(() =>
      expect(states.at(-1)?.tabs.filter((tab) => tab.owner === 'agent')).toHaveLength(2)
    );
    await manager.sweepTabs(workspaceId);
    advance();
    expect(await manager.sweepTabs(workspaceId)).toHaveLength(2);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(ownerPage.close).not.toHaveBeenCalled();
  });

  it('protects real download and dialog events until they finish', async () => {
    const { manager, context, session, open, advance } = await setup();
    const downloadId = await open();
    const dialogId = await open();
    let finish!: (stream: Readable) => void;
    const stream = new Promise<Readable>((resolve) => {
      finish = resolve;
    });
    context.all[1]!.emit('download', {
      url: () => 'https://example.test/result.txt',
      suggestedFilename: () => 'result.txt',
      createReadStream: () => stream,
      delete: vi.fn(async () => {})
    });
    context.all[2]!.emit('dialog', {
      type: () => 'confirm',
      message: () => 'Keep this analysis?',
      page: () => context.all[2],
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {})
    });
    advance();
    expect(await manager.sweepTabs(workspaceId)).toEqual([]);
    expect(context.all[1]!.close).not.toHaveBeenCalled();
    expect(context.all[2]!.close).not.toHaveBeenCalled();
    finish(Readable.from([Buffer.from('results')]));
    await Promise.all([...session.pendingDownloads]);
    expect(await manager.sweepTabs(workspaceId)).toEqual([downloadId]);
    expect(session.tabs.has(dialogId)).toBe(true);
  });

  it('keeps tab metadata responsive when a background title read stalls', async () => {
    const { manager, root, context, states, open } = await setup();
    const id = await open();
    context.all[1]!.title.mockImplementation(() => new Promise(() => {}));
    context.all[1]!.emit('load');
    await expect(manager.retainTab(workspaceId, root, id, true)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tabId: id, title: 'A page', pinned: true })
      ])
    );
    expect(states.at(-1)?.tabs.find((tab) => tab.tabId === id)?.pinned).toBe(true);
  });
});
