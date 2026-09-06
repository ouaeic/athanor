import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from './browser.js';
import { DesktopControl } from './holder.js';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const driver = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));
vi.mock('./playwright.js', () => ({ chromiumDriver: () => Promise.resolve(driver) }));

class Context extends EventEmitter {
  readonly page = new EventEmitter();
  readonly close = vi.fn(async () => {
    this.emit('close');
  });
  readonly pages = vi.fn(() => [this.page]);
  readonly newPage = vi.fn(() => Promise.resolve(this.page));
}

const roots: string[] = [];
const contexts: Context[] = [];
const managers: BrowserManager[] = [];
const workspace = 'browser-lifecycle';
const setup = async (options: Partial<ConstructorParameters<typeof BrowserManager>[0]> = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'athanor-browser-lifecycle-'));
  roots.push(root);
  const manager = new BrowserManager({ maxFileBytes: 1_000_000, ...options });
  managers.push(manager);
  driver.launchPersistentContext.mockImplementation(() => {
    const context = new Context();
    contexts.push(context);
    return Promise.resolve(context);
  });
  return { manager, root };
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close(workspace)));
  for (const context of contexts.splice(0)) context.emit('close');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  driver.launchPersistentContext.mockReset();
});

describe('persistent browser ownership', () => {
  it('shares one completed startup across simultaneous cold reads', async () => {
    const { manager, root } = await setup();
    const [first, second] = await Promise.all([
      manager.ensure(workspace, root),
      manager.ensure(workspace, root)
    ]);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('closes a startup already in flight and permits a fresh session afterwards', async () => {
    const { manager, root } = await setup();
    const gate = deferred<Context>();
    const context = new Context();
    contexts.push(context);
    driver.launchPersistentContext.mockImplementationOnce(() => gate.promise);
    const starting = manager.ensure(workspace, root);
    await vi.waitFor(() => expect(driver.launchPersistentContext).toHaveBeenCalledTimes(1));
    const closing = manager.close(workspace);
    gate.resolve(context);
    const first = await starting;
    await closing;
    expect(context.close).toHaveBeenCalledTimes(1);
    const reopened = await manager.ensure(workspace, root);
    expect(reopened).not.toBe(first);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('does not hand out the closing session to a concurrent reopen', async () => {
    const { manager, root } = await setup();
    const first = await manager.ensure(workspace, root);
    const context = contexts[0]!;
    const gate = deferred<void>();
    context.close.mockImplementationOnce(async () => {
      await gate.promise;
      context.emit('close');
    });
    const closing = manager.close(workspace);
    let returned = false;
    const reopening = manager.ensure(workspace, root).then((session) => {
      returned = true;
      return session;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeClose = returned;
    gate.resolve();
    await closing;
    const second = await reopening;
    expect(returnedBeforeClose).toBe(false);
    expect(second).not.toBe(first);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('closes a context when page initialization fails and allows a later retry', async () => {
    const { manager, root } = await setup();
    const context = new Context();
    contexts.push(context);
    context.pages.mockReturnValue([]);
    context.newPage.mockRejectedValueOnce(new Error('Page creation failed'));
    driver.launchPersistentContext.mockResolvedValueOnce(context);
    await expect(manager.ensure(workspace, root)).rejects.toThrow('Page creation failed');
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(manager.ensure(workspace, root)).resolves.toBeDefined();
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('evicts a closed context so the next read can recreate the browser', async () => {
    const { manager, root } = await setup();
    const first = await manager.ensure(workspace, root);
    const detach = vi.fn(first.detachControl);
    first.detachControl = detach;
    contexts[0]!.emit('close');
    expect(detach).toHaveBeenCalledTimes(1);
    const second = await manager.ensure(workspace, root);
    expect(second).not.toBe(first);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it.each(['page creation', 'desktop control'])(
    'rejects a context closed during pending %s and reopens without attaching stale control',
    async (phase) => {
      const gate = deferred<void>();
      const shared = new DesktopControl();
      const attach = vi.spyOn(shared, 'attach');
      const desktopControl = vi.fn(async () => {
        if (phase === 'desktop control') await gate.promise;
        return shared;
      });
      const { manager, root } = await setup({ desktopControl });
      const context = new Context();
      contexts.push(context);
      if (phase === 'page creation') {
        context.pages.mockReturnValue([]);
        context.newPage.mockImplementationOnce(async () => {
          await gate.promise;
          return context.page;
        });
      }
      driver.launchPersistentContext.mockResolvedValueOnce(context);
      const starting = manager.ensure(workspace, root);
      await vi.waitFor(() =>
        expect(phase === 'page creation' ? context.newPage : desktopControl).toHaveBeenCalledOnce()
      );
      context.emit('close');
      gate.resolve();
      await expect(starting).rejects.toThrow('Browser context closed during startup');
      expect(attach).not.toHaveBeenCalled();
      expect(context.close).toHaveBeenCalledOnce();

      const reopened = await manager.ensure(workspace, root);
      expect(reopened.context).toBe(contexts[1]);
      expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
      expect(attach).toHaveBeenCalledOnce();
      context.emit('close');
      expect(await manager.ensure(workspace, root)).toBe(reopened);
      await manager.close(workspace);
      await manager.ensure(workspace, root);
      expect(driver.launchPersistentContext).toHaveBeenCalledTimes(3);
    }
  );

  it('clears a failed launch so a later request can retry', async () => {
    const { manager, root } = await setup();
    driver.launchPersistentContext.mockRejectedValue(new Error('Launch refused'));
    const outcomes = await Promise.allSettled([
      manager.ensure(workspace, root),
      manager.ensure(workspace, root)
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const context = new Context();
    contexts.push(context);
    driver.launchPersistentContext.mockResolvedValue(context);
    await expect(manager.ensure(workspace, root)).resolves.toMatchObject({ context });
  });

  it('retries failed startup cleanup before launching a replacement context', async () => {
    const { manager, root } = await setup();
    const context = new Context();
    contexts.push(context);
    context.pages.mockReturnValue([]);
    context.newPage.mockRejectedValue(new Error('Page creation failed'));
    context.close.mockRejectedValueOnce(new Error('Close refused'));
    driver.launchPersistentContext.mockResolvedValueOnce(context);
    await expect(manager.ensure(workspace, root)).rejects.toThrow();
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(manager.ensure(workspace, root)).resolves.toBeDefined();
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });
});
