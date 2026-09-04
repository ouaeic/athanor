/**
 * The room behind the interface, and the glass in front of it.
 *
 * Everything here is decorative, so everything here is optional. The module is reached only through
 * a dynamic import, which keeps it and its stylesheet out of the eager bundle entirely, and the
 * switch runs in the safe direction: surfaces keep the fills they have always had until this
 * renderer has actually drawn a frame, at which point it sets `data-glass="on"` and the stylesheet
 * hands those surfaces over. No WebGL2, a refused preference, a failed chunk, a lost context or a
 * missing asset all leave the interface exactly as it is without the module, rather than leaving a
 * set of transparent holes where the panels used to be.
 *
 * WHY ONLY CHROME GETS GLASS. The surfaces below are the ones that float above content - bars, the
 * composer, sheets, the palette. Cards inside the transcript are deliberately left filled, and not
 * for taste: iOS Safari scrolls off the main thread, so a plate tracking a momentum-scrolled card
 * is positioned from a rect this loop measured one or more frames ago and visibly lags behind the
 * text it belongs to. Fixed and sticky chrome does not move under the compositor, so it does not
 * have that problem.
 */
import { createRenderer, MATERIAL, type Pane, type Renderer, type Surface } from './renderer.js';
import './glass.css';

/**
 * What becomes glass. Every one of these already painted a grey fill.
 *
 * NOT on the list, deliberately: inline text runs. `.markdown code`, `kbd`, table cells and
 * `.diff-line` are grey, but they are decorations on a line of prose rather than blocks or
 * controls, they are unbounded in number - one per code span, one per diff line - and a lens the
 * size of a word is a smear rather than a surface. They keep their fills.
 *
 * This list is the ONLY place the set is written down. The stylesheet does not repeat it: the rule
 * that hands these surfaces to the renderer is generated from this array at startup and injected as
 * a single <style>. Repeating a hundred selectors in two files is a guarantee that one day they
 * disagree, and a selector present in one and absent from the other is a surface that is either
 * invisible or unlit - the two failures hardest to spot and hardest to attribute.
 */
const SURFACES = [
  // App frame and sidebar chrome
  '.workbench-header',
  '.inspector-tabs',
  '.computer-toolbar',
  '.mobile-tabs',
  '.mobile-tabs button.active',
  '.pane-toolbar',
  '.browser-controls',
  '.browser-controls .address',
  '.browser-status',
  '.browser-status button',
  '.browser-viewport',
  '.terminal-pane',
  '.terminal-closed',
  '.terminal-keys',
  '.terminal-keys > button',
  '.terminal-new-session',
  '.search',
  '.brand-mark',
  '.workspace-switcher',
  '.workspace-switcher:hover',
  '.workspace-avatar',
  '.user-avatar',
  '.queue-pill',
  '.schedule-task',
  '.schedule-task:hover',
  '.sidebar > .computer-summary',
  '.account-row:hover',
  '.task-row:hover',
  '.task-row.active',
  '.task-row.renaming input',
  '.search-result.active-result .task-row',
  '.file-list .file-open:hover',
  '.wall-banner',

  // The composer column
  '.composer',
  '.composer-context',
  '.composer-block',
  '.composer-block button',
  '.usage-warning',
  '.usage-warning button',
  '.inline-error',
  '.inline-notice',
  '.form-error',
  '.fork-bar',
  '.spend-ceiling-ask',
  '.spend-ceiling-ask button',
  '.spend-ceiling-ask input',
  '.attachment-chip',
  '.attachment-thumb',

  // Sheets, panels and overlays
  '.modal',
  '.modal-close',
  '.auth-form-wrap',
  '.settings-section',
  '.settings-nav',
  '.settings-nav button.active',
  '.settings-nav button:hover',
  '.settings-list > div',
  '.palette',
  '.palette-entry[data-active="true"]',
  '.undo-toast',
  '.undo-action',
  '.skip-link',
  '.approval-drawer',
  '.approval-symbol',
  '.restore-confirmation',
  '.recovery-card',
  '.recovery-code',
  '.relay-status',
  '.relay-address',
  '.spend-card',
  '.schedule-row',
  '.schedule-form',
  '.weekday-picker button',
  '.toggle-line',
  '.toggle-row',
  '.running-row',
  '.notice-row',
  '.enrollment-card',
  '.rewind-effects',
  '.trajectory-scope-note',
  '.trajectory-rewind label',
  '.success-icon',
  '.server-install-icon',
  '.composer-sheet-connect',
  '.composer-sheet-row:hover:enabled',
  '.composer-sheet-row.chosen',

  // Inspector, files, preview
  '.file-preview',
  '.browser-input',
  '.browser-input button',
  '.browser-error',
  '.browser-error button',
  '.preview-row',
  '.preview-create',
  '.preview-frame-wrap',
  '.preview-actions button',
  '.deliverable-row',
  '.deliverable-row a',
  '.deliverable-row button',
  '.overwrite-choice',
  '.file-naming input',

  // Transcript cards. The ledger rows themselves are already unfilled, so what is
  // left here is the small number of genuinely boxed things in a turn.
  '.user-brief',
  '.completion-card',
  '.task-result',
  '.task-plan-panel',
  '.task-plan-conflict',
  '.task-plan-actions button',
  '.task-plan-add',
  '.artifact-card',
  '.artifact-actions button',
  '.artifact-actions a',
  '.browser-capture-card',
  '.browser-capture-card button',
  '.preview-chat-card',
  '.preview-chat-icon',
  '.pdf-review-card',
  '.handoff-card',
  '.spend-pause-card',
  '.agent-note',
  '.code-block',
  '.file-diff',
  '.provenance-summary',
  '.computer-rewound',
  '.jump-to-latest',
  '.answer-sources a',
  '.source-index',
  '.blocked-resource',
  '.earlier-in-conversation',
  '.starter-capabilities button',
  '.tool-pages a',
  '.message-actions button:hover',
  '.copy-button:hover',
  '.task-row-actions button:hover',
  '.attachment-remove:hover',

  // Controls, everywhere
  '.primary',
  '.secondary',
  '.ghost',
  '.header-pill',
  '.workspace-tools-button',
  '.workspace-tools-button.active',
  '.new-task',
  '.send-btn',
  '.icon-btn:hover',
  '.icon-btn.recording',
  '.update-offer button',
  'button:not([class])',

  // Inputs
  'input:not([type="range"]):not([type="checkbox"]):not([type="radio"])',
  'textarea',
  'select'
].join(',');

/**
 * Everything the surfaces must stop doing for themselves. The renderer paints the refraction, the
 * frosting and the lit edge underneath them, so the element has to contribute nothing: no fill to
 * cover the lens, no border to disagree with the edge being drawn, no shadow - which on this
 * material comes from the falloff rather than from a box - and no blur of its own, since running a
 * second one would cost a full-screen readback per surface per frame to no visible end.
 */
const NEUTRALISE = [
  'background: transparent',
  'border-color: transparent',
  'box-shadow: none',
  'backdrop-filter: none',
  '-webkit-backdrop-filter: none'
].join(';');

const POSTER = '/room/room-poster.jpg';
const FIRE = '/room/fire.mp4';

/** Above this the fill rate stops buying anything a backdrop this soft can show. */
const MAX_DPR = 2;

const supported = (): boolean => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  if (document.documentElement.dataset.glass === 'off') return false;
  // Unsupported in every version of mobile Safari, deliberately, on fingerprinting grounds - so it
  // is honoured where it exists and the in-app switch is what actually carries the preference.
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return false;
  const probe = document.createElement('canvas');
  return Boolean(probe.getContext('webgl2'));
};

const readSurfaces = (canvasHeight: number, dpr: number): Surface[] => {
  const found: Surface[] = [];
  for (const element of document.querySelectorAll(SURFACES)) {
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const declared = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    found.push({
      cx: (box.left + box.width / 2) * dpr,
      cy: canvasHeight - (box.top + box.height / 2) * dpr,
      hw: (box.width / 2) * dpr,
      hh: (box.height / 2) * dpr,
      radius: Math.min(declared, Math.min(box.width, box.height) / 2) * dpr
    });
  }
  return found;
};

/**
 * Two surfaces belong to the same pane when they touch, or come within a hair of touching. The
 * gap is measured between the rectangles rather than between their centres, so a tall button beside
 * a short one joins on the same rule as two equals.
 */
const GAP = 14;

/** How much of a surface must be swallowed by another before it counts as sitting INSIDE it. */
const inside = (a: Surface, b: Surface): boolean =>
  a !== b &&
  a.hw * a.hh < b.hw * b.hh &&
  Math.abs(a.cx - b.cx) + a.hw <= b.hw + 1 &&
  Math.abs(a.cy - b.cy) + a.hh <= b.hh + 1;

const apart = (a: Surface, b: Surface): number => {
  const dx = Math.max(0, Math.abs(a.cx - b.cx) - (a.hw + b.hw));
  const dy = Math.max(0, Math.abs(a.cy - b.cy) - (a.hh + b.hh));
  return Math.hypot(dx, dy);
};

/**
 * Sorts the surfaces into panes.
 *
 * Touching surfaces become one pane: one lens, one edge, one falloff, with the members surviving
 * only as seams scored across it. A surface that sits wholly inside another does NOT join it - it
 * becomes its own pane, marked inset, and the renderer turns its lens inside out so it reads as
 * cut into the glass rather than laid on top of it. That is the whole difference between a button
 * on a toolbar and a button in one.
 */
const toPanes = (
  surfaces: readonly Surface[],
  dpr: number
): { ordered: Surface[]; panes: Pane[] } => {
  const n = surfaces.length;
  const nested = surfaces.map((a) => surfaces.some((b) => inside(a, b)));

  // Union-find over the surfaces that are not nested inside something else.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const gap = GAP * dpr;
  for (let i = 0; i < n; i++) {
    if (nested[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (nested[j]) continue;
      if (apart(surfaces[i]!, surfaces[j]!) <= gap) parent[find(i)] = find(j);
    }
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const key = nested[i] ? -1 - i : find(i);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  const ordered: Surface[] = [];
  const panes: Pane[] = [];
  for (const [key, members] of buckets) {
    const start = ordered.length;
    let left = Infinity,
      right = -Infinity,
      bottom = Infinity,
      top = -Infinity;
    for (const i of members) {
      const s = surfaces[i]!;
      ordered.push(s);
      left = Math.min(left, s.cx - s.hw);
      right = Math.max(right, s.cx + s.hw);
      bottom = Math.min(bottom, s.cy - s.hh);
      top = Math.max(top, s.cy + s.hh);
    }
    panes.push({
      cx: (left + right) / 2,
      cy: (bottom + top) / 2,
      hw: (right - left) / 2,
      hh: (top - bottom) / 2,
      start,
      count: members.length,
      inset: key < 0
    });
  }
  return { ordered, panes };
};

const sameSurfaces = (a: readonly Surface[], b: readonly Surface[]): boolean =>
  a.length === b.length &&
  a.every((s, i) => {
    const other = b[i]!;
    return (
      Math.abs(s.cx - other.cx) < 0.5 &&
      Math.abs(s.cy - other.cy) < 0.5 &&
      Math.abs(s.hw - other.hw) < 0.5 &&
      Math.abs(s.hh - other.hh) < 0.5 &&
      Math.abs(s.radius - other.radius) < 0.5
    );
  });

/**
 * Starts the backdrop. Returns the teardown, which every caller owes: in development this module is
 * evaluated again on every hot update, and a second canvas over the first is two video decodes.
 */
export const startGlass = (): (() => void) => {
  if (!supported()) return () => {};

  const canvas = document.createElement('canvas');
  canvas.className = 'glass-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  // `inertOutside` walks up from an open dialog marking every sibling inert. This layer has no
  // focusable content so being inert is harmless, but the attribute would churn on every dialog,
  // and the undo layer already established `data-layer` as the way to opt out of that sweep.
  canvas.dataset.layer = 'glass';

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return () => {};

  const root = document.getElementById('root');
  document.body.insertBefore(canvas, root);

  // Generated rather than written out, so the set of glass surfaces has one definition. Scoped on
  // the same attribute as everything else, so it cannot apply before a frame has been drawn.
  const sheet = document.createElement('style');
  sheet.dataset.layer = 'glass';
  sheet.textContent = `html[data-glass='on'] :is(${SURFACES}){${NEUTRALISE}}`;
  document.head.append(sheet);

  let renderer: Renderer | null = createRenderer(gl, MATERIAL);
  let source: HTMLImageElement | HTMLVideoElement | null = null;
  let painted = false;
  let dirty = true;
  let frameReady = true;
  let surfaces: Surface[] = [];
  let raf = 0;
  let dpr = 1;

  const still = new Image();
  still.decoding = 'async';
  still.src = POSTER;
  still.addEventListener('load', () => {
    source ??= still;
    dirty = true;
  });

  /* The room is a still, and stays one. The only thing that moves is the fire, which is a small
     clip of its own corner - so nothing can drift, because nothing else is being drawn. It is also
     what keeps this loop running: when it is absent or refused, the picture is simply the painting.

     Held still under a reduced-motion preference, where the first frame of the clip is the corner
     exactly as the painting has it. */
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let fire: HTMLVideoElement | null = null;
  let fireReady = false;
  if (!calm.matches) {
    fire = document.createElement('video');
    fire.src = FIRE;
    fire.muted = true;
    fire.loop = true;
    fire.playsInline = true;
    fire.preload = 'auto';
    /* Kept in the document rather than detached. A media element outside the tree is throttled or
       suspended outright by some engines, which stops the only moving thing in the picture; and it
       is hidden and inert, so it costs the layout and the reader nothing. */
    fire.dataset.layer = 'glass';
    fire.setAttribute('aria-hidden', 'true');
    fire.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-1px';
    document.body.append(fire);
    fire.addEventListener('loadeddata', () => {
      void fire?.play().catch(() => {
        fireReady = false;
      });
      const onFrame = (): void => {
        fireReady = true;
        frameReady = true;
        fire?.requestVideoFrameCallback?.(onFrame);
      };
      if (fire?.requestVideoFrameCallback) fire.requestVideoFrameCallback(onFrame);
      else fireReady = true;
    });
  }

  const resize = (): void => {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    renderer?.resize(canvas.width, canvas.height, dpr);
    dirty = true;
  };
  resize();

  const observer = new ResizeObserver(() => {
    dirty = true;
  });
  observer.observe(document.body);

  /* The lean follows the pointer, eased rather than tracked, so it settles instead of twitching.
     Only for a pointer that can hover: on a touch screen every "move" is a drag, and a room that
     lurches whenever a finger lands is motion nobody asked for. */
  const hovers = window.matchMedia('(hover: hover) and (pointer: fine)');
  let wantX = 0;
  let wantY = 0;
  let haveX = 0;
  let haveY = 0;

  const onPointerMove = (event: PointerEvent): void => {
    if (!hovers.matches || calm.matches) return;
    wantX = (event.clientX / window.innerWidth) * 2 - 1;
    wantY = (event.clientY / window.innerHeight) * 2 - 1;
  };

  const settleLean = (): boolean => {
    const nextX = haveX + (wantX - haveX) * 0.08;
    const nextY = haveY + (wantY - haveY) * 0.08;
    if (Math.abs(nextX - haveX) < 0.0005 && Math.abs(nextY - haveY) < 0.0005) return false;
    haveX = nextX;
    haveY = nextY;
    renderer?.lean(haveX, haveY);
    return true;
  };

  const onPointerDown = (event: PointerEvent): void => {
    renderer?.ripple(event.clientX * dpr, canvas.height - event.clientY * dpr);
    dirty = true;
  };

  const onLost = (event: Event): void => {
    // Losing the context on iOS when the tab is backgrounded is routine. Hand the interface back to
    // its own fills rather than leaving it transparent over a dead canvas.
    event.preventDefault();
    delete document.documentElement.dataset.glass;
    painted = false;
  };
  const onRestored = (): void => {
    renderer = createRenderer(gl, MATERIAL);
    resize();
  };

  window.addEventListener('resize', resize);
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    if (!renderer || !source) return;

    const next = readSurfaces(canvas.height, dpr);
    if (!sameSurfaces(next, surfaces)) {
      surfaces = next;
      dirty = true;
    }
    if (settleLean()) dirty = true;

    /* The fire is the only thing that moves now, so it is what keeps this loop alive - and it does
       so at half the display's rate, because a flame does not need sixty steps a second and every
       step redraws the whole frame. When the fire is out, nothing is animating and nothing is
       drawn. */
    // A still room with nothing moving in front of it is a frame that does not need drawing.
    if (!dirty && !frameReady) return;
    frameReady = false;
    dirty = false;

    const { ordered, panes } = toPanes(surfaces, dpr);
    renderer.draw(source, ordered, panes, now, fireReady ? fire : null);

    if (!painted) {
      painted = true;
      document.documentElement.dataset.glass = 'on';
    }
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    fire?.pause();
    fire?.remove();
    sheet.remove();
    renderer?.destroy();
    renderer = null;
    canvas.remove();
    delete document.documentElement.dataset.glass;
  };
};
