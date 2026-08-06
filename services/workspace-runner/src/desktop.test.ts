import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopControl,
  DesktopManager,
  classifyDesktopAction,
  clickCommand,
  dragCommand,
  imageToDisplayPoint,
  pressCommand,
  releaseAllInputCommand,
  scrollCommand,
  nodeUnderPoint,
  selectDesktopNodes,
  splitBridgeLines,
  toX11Keysym,
  typeCommand,
  type DesktopNode
} from './desktop.js';

const node = (overrides: Partial<DesktopNode> = {}): DesktopNode => ({
  id: '0/1',
  parentId: '0',
  name: 'Open document',
  description: '',
  role: 'push button',
  states: ['enabled'],
  actions: ['click'],
  interfaces: ['action', 'component'],
  bounds: { x: 10, y: 20, width: 100, height: 30 },
  sensitive: false,
  ...overrides
});

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('what the pixel path may do without stopping the owner', () => {
  /**
   * The mode that exists precisely for applications with no accessibility was close to inert. Every
   * coordinate click was consequential and every keystroke was treated as a secret, so driving such
   * an app meant approving each click and taking over the machine to type. The reason was sound -
   * a bare coordinate is unattributable, so the harness could not write an honest card and could
   * not tell Cancel from Delete - but the answer was to give it something to attribute against.
   */
  const at = (
    x: number,
    y: number,
    width: number,
    height: number,
    over: Partial<DesktopNode> = {}
  ): DesktopNode => ({
    id: `n-${x}-${y}`,
    parentId: null,
    name: 'Save',
    description: '',
    role: 'push button',
    states: ['enabled', 'showing'],
    actions: ['click'],
    interfaces: ['Action'],
    bounds: { x, y, width, height },
    sensitive: false,
    ...over
  });

  it('finds the smallest control under a point, because bounds nest', () => {
    const window = at(0, 0, 800, 600, { id: 'window', role: 'frame', name: 'App' });
    const panel = at(10, 10, 400, 300, { id: 'panel', role: 'panel', name: 'Toolbar' });
    const button = at(20, 20, 60, 24, { id: 'button', name: 'Save' });
    expect(nodeUnderPoint([window, panel, button], 40, 30)?.id).toBe('button');
    // A point inside the window but on no control is not attributable to anything smaller.
    expect(nodeUnderPoint([window, panel, button], 700, 500)?.id).toBe('window');
    expect(nodeUnderPoint([panel, button], 700, 500)).toBeUndefined();
  });

  it('judges a click that lands on a control exactly as clicking that control by name', () => {
    const ordinary = classifyDesktopAction(
      { type: 'click_at', x: 40, y: 30, button: 'left', clicks: 1 },
      at(20, 20, 60, 24, { name: 'Save' })
    );
    expect(ordinary.consequential).toBe(false);
    expect(ordinary.preview).toContain('Save');

    // The calibration the semantic path already had, now reaching the pixel path too.
    const grave = classifyDesktopAction(
      { type: 'click_at', x: 40, y: 30, button: 'left', clicks: 1 },
      at(20, 20, 60, 24, { name: 'Delete all messages' })
    );
    expect(grave.consequential).toBe(true);
  });

  it('still stops for a click on nothing this computer can name', () => {
    const blind = classifyDesktopAction({ type: 'click_at', x: 700, y: 500, button: 'left', clicks: 1 });
    expect(blind.consequential).toBe(true);
    expect(blind.preview).toContain('not on any control');
  });

  it('types into an ordinary field, and hands over only for a secret one', () => {
    const search = classifyDesktopAction(
      { type: 'text_input', text: 'invoices' },
      at(0, 0, 200, 24, { name: 'Search', role: 'text' })
    );
    expect(search.sensitiveInput).toBe(false);

    const password = classifyDesktopAction(
      { type: 'text_input', text: 'hunter2' },
      at(0, 0, 200, 24, { name: 'Password', role: 'password text', sensitive: true })
    );
    expect(password.sensitiveInput).toBe(true);

    // Nothing focused keeps the old answer, which is the case the rule was really protecting.
    expect(classifyDesktopAction({ type: 'text_input', text: 'x' }).sensitiveInput).toBe(true);
  });

  it('treats looking closely as a read', () => {
    const zoom = classifyDesktopAction({ type: 'zoom', x: 100, y: 100, width: 200, height: 120 });
    expect(zoom.consequential).toBe(false);
    expect(zoom.sensitiveInput).toBe(false);
  });
});

describe('which accessibility nodes an observation carries', () => {
  /**
   * Nine hundred nodes were collected and the window keeps twenty-four thousand characters of a
   * tool result - about seventy-four of them. So nine in ten were cut away by a generic
   * middle-truncation that did not know it was cutting JSON: the model got a fragment ending
   * mid-structure, no signal that anything was missing, and a snapshot still calling itself
   * semantic_and_visual. Dropping whole nodes at this end, worst first, and saying how many went,
   * is the difference between a partial answer and a corrupted one.
   */
  const node = (id: string, over: Partial<DesktopNode> = {}): DesktopNode => ({
    id,
    parentId: null,
    name: `control ${id}`,
    description: 'a control with a reasonably long description so the budget is realistic',
    role: 'push button',
    states: ['enabled', 'showing', 'visible'],
    actions: ['click'],
    interfaces: ['Action', 'Component'],
    bounds: { x: 10, y: 10, width: 80, height: 24 },
    sensitive: false,
    ...over
  });

  it('keeps what can be acted on and seen, and counts what it dropped', () => {
    const nodes = [
      // Structural furniture with no name and nothing to do: the cheapest thing to lose.
      ...Array.from({ length: 400 }, (_, index) =>
        node(`filler-${index}`, { name: '', actions: [], bounds: null, role: 'filler' })
      ),
      // The one control that matters, deliberately last in tree order so a head-truncation
      // would have thrown it away.
      node('save', { name: 'Save' })
    ];
    const { kept, omitted } = selectDesktopNodes(nodes);
    expect(kept.some((entry) => entry.id === 'save')).toBe(true);
    expect(omitted).toBeGreaterThan(0);
    expect(kept.length + omitted).toBe(nodes.length);
  });

  it('fits inside the budget a tool result actually has', () => {
    const nodes = Array.from({ length: 900 }, (_, index) => node(`n-${index}`));
    const { kept, omitted } = selectDesktopNodes(nodes);
    expect(JSON.stringify(kept).length).toBeLessThan(24_000);
    expect(omitted).toBe(900 - kept.length);
    // And it is not so cautious that the screen becomes unusable.
    expect(kept.length).toBeGreaterThan(20);
  });

  it('emits in tree order, so parentId still reads', () => {
    const nodes = [node('a'), node('b', { parentId: 'a' }), node('c', { parentId: 'b' })];
    expect(selectDesktopNodes(nodes).kept.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('desktop action policy', () => {
  it('detects consequential semantic controls', () => {
    expect(
      classifyDesktopAction(
        { type: 'invoke', nodeId: '0/1', actionIndex: 0 },
        node({ name: 'Submit job application' })
      )
    ).toMatchObject({ consequential: true, sensitiveInput: false });
  });

  it('routes password fields to secure user input', () => {
    expect(
      classifyDesktopAction(
        { type: 'set_text', nodeId: '0/2', text: 'never expose this' },
        node({ name: 'Password', role: 'password text', sensitive: true })
      )
    ).toMatchObject({ consequential: false, sensitiveInput: true });
  });

  it('treats pixel clicks and Enter as ambiguous consequential actions', () => {
    expect(
      classifyDesktopAction({ type: 'click_at', x: 10, y: 20, button: 'left', clicks: 1 })
        .consequential
    ).toBe(true);
    expect(classifyDesktopAction({ type: 'press', key: 'Enter' }).consequential).toBe(true);
    expect(classifyDesktopAction({ type: 'press', key: 'Return' }).consequential).toBe(true);
  });
});

describe('desktop key names', () => {
  it('translates DOM key names into X11 keysyms xdotool accepts', () => {
    expect(toX11Keysym('Enter')).toBe('Return');
    expect(toX11Keysym('Esc')).toBe('Escape');
    expect(toX11Keysym('Escape')).toBe('Escape');
    expect(toX11Keysym('ArrowUp')).toBe('Up');
    expect(toX11Keysym('ArrowDown')).toBe('Down');
    expect(toX11Keysym('ArrowLeft')).toBe('Left');
    expect(toX11Keysym('ArrowRight')).toBe('Right');
    expect(toX11Keysym(' ')).toBe('space');
    expect(toX11Keysym('Backspace')).toBe('BackSpace');
    expect(toX11Keysym('Delete')).toBe('Delete');
    expect(toX11Keysym('Tab')).toBe('Tab');
    expect(toX11Keysym('Home')).toBe('Home');
    expect(toX11Keysym('End')).toBe('End');
    expect(toX11Keysym('PageUp')).toBe('Prior');
    expect(toX11Keysym('PageDown')).toBe('Next');
  });

  it('keeps chords and ordinary characters usable', () => {
    expect(toX11Keysym('ctrl+Enter')).toBe('ctrl+Return');
    expect(toX11Keysym('Control+s')).toBe('ctrl+s');
    expect(toX11Keysym('Meta+ArrowLeft')).toBe('super+Left');
    expect(toX11Keysym('a')).toBe('a');
    expect(toX11Keysym('F5')).toBe('F5');
    expect(toX11Keysym('+')).toBe('plus');
  });

  it('covers the function, numpad, media and modifier keys the old map dropped', () => {
    expect(toX11Keysym('F13')).toBe('F13');
    expect(toX11Keysym('Numpad5')).toBe('KP_5');
    expect(toX11Keysym('NumpadAdd')).toBe('KP_Add');
    expect(toX11Keysym('NumpadEnter')).toBe('KP_Enter');
    expect(toX11Keysym('AudioVolumeUp')).toBe('XF86AudioRaiseVolume');
    expect(toX11Keysym('MediaPlayPause')).toBe('XF86AudioPlay');
    expect(toX11Keysym('AltGraph')).toBe('ISO_Level3_Shift');
    expect(toX11Keysym('ContextMenu')).toBe('Menu');
    expect(toX11Keysym('PrintScreen')).toBe('Print');
    expect(toX11Keysym('CapsLock')).toBe('Caps_Lock');
    expect(toX11Keysym('-')).toBe('minus');
    expect(toX11Keysym('/')).toBe('slash');
    expect(toX11Keysym('ctrl+AltGraph+F12')).toBe('ctrl+ISO_Level3_Shift+F12');
  });

  it('routes characters no layout can produce through the unicode keysym range', () => {
    expect(toX11Keysym('é')).toBe('U00E9');
    expect(toX11Keysym('漢')).toBe('U6F22');
    expect(toX11Keysym('€')).toBe('U20AC');
    // Astral-plane characters are one code point, not two UTF-16 units.
    expect(toX11Keysym('😀')).toBe('U1F600');
  });
});

describe('desktop input commands', () => {
  it('moves the pointer before clicking and only paces repeated clicks', () => {
    expect(clickCommand({ x: 12.4, y: 40.6 }, 'right', 1)).toEqual([
      'mousemove',
      '--sync',
      '12',
      '41',
      'click',
      '3'
    ]);
    expect(clickCommand({ x: 0, y: 0 }, 'left', 2)).toEqual([
      'mousemove',
      '--sync',
      '0',
      '0',
      'click',
      '--repeat',
      '2',
      '--delay',
      '100',
      '1'
    ]);
  });

  it('scrolls at a point, on the horizontal buttons, without a per-tick delay', () => {
    expect(scrollCommand({ x: 400, y: 300 }, 'down', 3)).toEqual([
      'mousemove',
      '--sync',
      '400',
      '300',
      'click',
      '--repeat',
      '3',
      '--delay',
      '0',
      '5'
    ]);
    expect(scrollCommand({ x: 1, y: 2 }, 'left', 1)).toContain('6');
    expect(scrollCommand({ x: 1, y: 2 }, 'right', 1)).toContain('7');
    expect(scrollCommand({ x: 1, y: 2 }, 'up', 1)).toContain('4');
    // A trackpad fling must not wedge the queue behind hundreds of synthetic clicks.
    expect(scrollCommand({ x: 1, y: 2 }, 'down', 100)).toContain('12');
  });

  it('drags with interpolated motion that clears the toolkit drag threshold', () => {
    const args = dragCommand({ x: 0, y: 0 }, { x: 400, y: 0 }, 960);
    // 'xdotool mousemove' has no --steps option; passing one made every drag fail.
    expect(args).not.toContain('--steps');
    const down = args.indexOf('mousedown');
    expect(down).toBeGreaterThan(0);
    const firstMove = args.indexOf('mousemove', down);
    expect(Number(args[firstMove + 2])).toBeGreaterThanOrEqual(8);
    expect(args.filter((value) => value === 'mousemove').length).toBeGreaterThan(3);
    expect(args.slice(-2)).toEqual(['mouseup', '1']);
    expect(args[args.length - 3]).toBe('0.05');
    const lastMove = args.lastIndexOf('mousemove');
    expect(args.slice(lastMove, lastMove + 4)).toEqual(['mousemove', '--sync', '400', '0']);
  });

  it('releases every latched modifier and button on a handover', () => {
    const args = releaseAllInputCommand();
    expect(args.join(' ')).toContain('keyup Control_L');
    expect(args.join(' ')).toContain('keyup Shift_R');
    expect(args.join(' ')).toContain('keyup ISO_Level3_Shift');
    expect(args.join(' ')).toContain('mouseup 1');
    expect(args.join(' ')).toContain('mouseup 3');
  });

  it('types at the keymap settle time and never clears modifiers behind the caller', () => {
    expect(typeCommand('héllo')).toEqual(['type', '--delay', '12', '--', 'héllo']);
    expect(pressCommand('ctrl+Enter')).toEqual(['key', 'ctrl+Return']);
    expect(typeCommand('x')).not.toContain('--clearmodifiers');
    expect(pressCommand('a')).not.toContain('--clearmodifiers');
  });

  it('converts screenshot coordinates into display pixels', () => {
    expect(
      imageToDisplayPoint(
        { x: 720, y: 450 },
        { width: 1440, height: 900 },
        { width: 2560, height: 1600 }
      )
    ).toEqual({ x: 1280, y: 800 });
    expect(
      imageToDisplayPoint(
        { x: 0, y: 0 },
        { width: 1440, height: 900 },
        { width: 1440, height: 900 }
      )
    ).toEqual({ x: 0, y: 0 });
    // Never let a rounded edge coordinate land outside the display.
    expect(
      imageToDisplayPoint(
        { x: 1440, y: 900 },
        { width: 1440, height: 900 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ x: 1279, y: 799 });
  });
});

describe('desktop accessibility bridge framing', () => {
  it('reassembles newline delimited responses split across pipe reads', () => {
    const first = splitBridgeLines('', '{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b":');
    const second = splitBridgeLines(first.rest, '2}\n\n{"c":3}\n');
    expect(second.lines).toEqual(['{"b":2}', '{"c":3}']);
    expect(second.rest).toBe('');
    expect(splitBridgeLines('', 'partial').lines).toEqual([]);
  });
});

describe('desktop session lifecycle', () => {
  const withSession = async (
    body: (manager: DesktopManager, root: string) => Promise<void>
  ): Promise<void> => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-desktop-'));
    const script = path.join(root, 'session.sh');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'set -eu',
        'mkdir -p "$1/.athanor/desktop"',
        'printf "DISPLAY=:99\\nDBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null\\n' +
          'XDG_RUNTIME_DIR=%s\\nATHANOR_BOOT_RES=1600x1000\\nATHANOR_MAX_RES=3840x2160\\n"' +
          ' "$1" > "$1/.athanor/desktop/environment"',
        'exec sleep 30'
      ].join('\n'),
      { mode: 0o755 }
    );
    const manager = new DesktopManager('/nonexistent/bridge.py', script, [
      '/usr/local/lib/athanor/athanor-package-helper'
    ]);
    try {
      await body(manager, root);
    } finally {
      await manager.close('workspace');
      await rm(root, { recursive: true, force: true });
    }
  };

  it('takes its geometry from the session and reports the agent image space', async () => {
    await withSession(async (manager, root) => {
      // No X11 on the test host: every X tool fails and the snapshot degrades, which is
      // exactly the path that must still produce a coherent coordinate space.
      const snapshot = await manager.snapshot('workspace', root, 'agent');
      expect(snapshot).toMatchObject({
        available: true,
        mode: 'visual_fallback',
        holder: 'agent',
        generation: 1,
        displayWidth: 1600,
        displayHeight: 1000,
        width: 1440,
        height: 900,
        screenshotMimeType: 'image/jpeg'
      });
      expect(snapshot.scale).toBeCloseTo(0.9, 6);
    });
  }, 20_000);

  it('hands control over and refuses the previous holder afterwards', async () => {
    await withSession(async (manager, root) => {
      const before = await manager.snapshot('workspace', root, 'agent');
      const handover = await manager.setHolder('workspace', root, 'user');
      expect(handover).toEqual({ holder: 'user', generation: before.generation + 1 });
      await expect(
        manager.act('workspace', root, { type: 'press', key: 'Enter' }, 'agent', true)
      ).rejects.toThrow('Desktop control is held by user');
      await expect(manager.snapshot('workspace', root, 'agent')).rejects.toThrow(
        'held by the user'
      );
    });
  }, 20_000);

  it('applies the same command policy a shell command gets, which it used to skip entirely', async () => {
    // desktop_launch spawned whatever it was handed. Everything the shell refuses ran unchecked
    // simply by asking for a window instead of a pipe.
    await withSession(async (manager, root) => {
      const refused = [
        { executable: '/usr/bin/sudo', args: ['id'] },
        { executable: 'pkexec', args: ['id'] },
        { executable: '/usr/bin/apt-get', args: ['install', '-y', 'openssh-server'] },
        { executable: '/usr/local/lib/athanor/athanor-package-helper', args: ['install', 'nmap'] }
      ];
      for (const request of refused)
        await expect(
          manager.launch('workspace', root, { ...request, cwd: 'workspace', env: {} })
        ).rejects.toThrow('cannot be started as desktop programs');
    });
  }, 20_000);
});

describe('desktop control arbitration', () => {
  const build = (settleMs?: number) => {
    const release = vi.fn(async () => undefined);
    const changes: number[] = [];
    const control = new DesktopControl({
      release,
      onChange: (state) => changes.push(state.generation),
      ...(settleMs === undefined ? {} : { settleMs })
    });
    return { control, release, changes };
  };

  it('serializes input so two transactions never interleave', async () => {
    const { control } = build();
    const order: string[] = [];
    const first = control.submit('agent', async () => {
      order.push('first:start');
      await delay(20);
      order.push('first:end');
      return 1;
    });
    const second = control.submit('agent', async () => {
      order.push('second:start');
      return 2;
    });
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('refuses input from anyone but the holder, and stale coordinates from the holder', async () => {
    const { control } = build();
    await expect(control.submit('user', async () => 'nope')).rejects.toThrow(
      'Desktop control is held by agent'
    );
    await expect(control.submit('agent', async () => 'nope', { generation: 99 })).rejects.toThrow(
      'stale'
    );
    await expect(control.submit('agent', async () => 'ok', { generation: 1 })).resolves.toBe('ok');
  });

  it('takes over preemptively: queued agent work is discarded and input is released', async () => {
    const { control, release, changes } = build();
    let ran = 0;
    const inFlight = control.submit('agent', async () => {
      ran += 1;
      await delay(20);
      return 'in-flight';
    });
    const queued = control.submit('agent', async () => {
      ran += 1;
      return 'queued';
    });
    const takeover = control.transfer('user');
    await expect(queued).rejects.toThrow('Desktop control was handed to user');
    await expect(inFlight).resolves.toBe('in-flight');
    const state = await takeover;
    expect(ran).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(state.holder).toBe('user');
    expect(state.generation).toBe(2);
    expect(changes).toEqual([2]);
    await expect(control.submit('agent', async () => 'nope')).rejects.toThrow(
      'Desktop control is held by user'
    );
    await expect(control.submit('user', async () => 'mine')).resolves.toBe('mine');
  });

  it('force-completes a transaction that overruns the settle window', async () => {
    const { control, release } = build(5);
    const drag = control.submit(
      'agent',
      async (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('forced'));
        })
    );
    await control.transfer('user');
    expect(await drag).toBe('forced');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached coordinates on handback and on resize', async () => {
    const { control, changes } = build();
    await control.transfer('user');
    await control.transfer('agent');
    expect(control.holder).toBe('agent');
    expect(control.generation).toBe(3);
    control.bumpGeneration();
    expect(control.generation).toBe(4);
    expect(changes).toEqual([2, 3, 4]);
    await expect(control.submit('agent', async () => 'x', { generation: 3 })).rejects.toThrow(
      'stale'
    );
  });

  it('serializes concurrent handovers instead of racing them', async () => {
    const { control, release } = build();
    const [first, second] = await Promise.all([
      control.transfer('user'),
      control.transfer('secure_input')
    ]);
    expect(first.generation).toBe(2);
    expect(second.generation).toBe(3);
    expect(control.holder).toBe('secure_input');
    expect(release).toHaveBeenCalledTimes(2);
  });
});
