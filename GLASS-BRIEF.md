# Prompt for a fresh conversation — Liquid Glass + starfield for athanor

Copy everything below the line into a new conversation in this project.

---

I want you to build a proper Apple-style **Liquid Glass** interface for athanor, over a **starfield
we are flying through**. A previous attempt failed. Read this whole brief before touching anything —
it tells you exactly what was tried, what is verified true, and what is still unknown, so you do not
repeat a week of work.

## The product

athanor is free AGPL-3.0 software that turns one Linux server into a persistent private AI agent
computer for a single owner, reachable from any device. Repo is this folder. React 19, strict TS,
pnpm, Node 24 — prefix shell commands with `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
Dev server: `pnpm dev` on :5173. Live box: `administrator@85.190.100.211` via `~/.ssh/one-hermes-vps`,
deploy is `sudo athanor update` (pulls from the public GitHub origin, so push first). **Do not deploy
anything unfinished.**

## What I want

- **True black OLED interface. Monochrome.** No colour anywhere except the small animated flame in
  the brand mark. Minimising OLED energy is a deliberate design goal.
- **Nothing that is not glass or open space.** No grey fills, no tinted panels, no painted rims, no
  drop shadows, no inner shadows, no grain, no fake specular highlights. If a surface exists it is
  because light bends through it. The effect must speak for itself.
- **Real Apple-style Liquid Glass**: actual refraction and light-bending, both the _morphous_ and
  _amorphous_ behaviours, including **ripples**. Not 2015 glassmorphism, not `backdrop-filter: blur()`
  with a white border.
- **A starfield we are flying through**, like a spaceship. Gentle but not slow — a bit faster than a
  drift. Stars must be **small points of light, all roughly the same size**, with only very subtle
  size variation. No streaks, no speed lines, no warp-tunnel clichés. Realistic.

## Research this properly — do not reinvent it

There is a lot of public work on this since Apple shipped Liquid Glass in 2025. Find it and use it.
Look for the morphous/amorphous distinction, ripple and caustic techniques, and the efficient
implementations. Read real source, not blog summaries. Fetch actual stylesheets and repos. There are
libraries, CodePens, WebGL shader implementations and long technical threads — go and read them
rather than deriving from first principles, which is what the last attempt did and why it failed.

## Verified findings — trust these, they were measured, not assumed

1. **`backdrop-filter: url(#svgfilter)` is unusable.** Chromium-only. WebKit bug 245510 still open.
   Worse: in WebKit `RenderLayerBacking.cpp` tests `hasReferenceFilter()` against the _whole_
   operation list, so one `url()` discards the entire declaration — you do not fall back to blur,
   you get nothing. `CSS.supports()` returns true for it, so there is no feature test. iOS Safari is
   the primary target. Never write it.
2. **`filter: url()` on a copy of the backdrop DOES work in WebKit**, and `feDisplacementMap` works
   everywhere. This was verified in-browser: a reference grid visibly curves and pinches at the
   bezel. The mechanism is sound.
3. **SVG filters cache by id.** Mutating an existing filter's `feImage` href never rebuilds it — the
   map silently stays whatever it first was. This cost hours. Use a fresh filter id on every
   regeneration.
4. **`saturate()` is a bit-identical no-op on a monochrome UI.** Every row of the CSS saturation
   matrix sums to 1.0, so grey in = grey out. Do not put it in a backdrop-filter chain here.
5. **A white tint cannot attenuate a white star.** `#ffffff0b` over a 255 star returns 255. If you
   need to bound a backdrop, the fill must be a dark multiply (`#191919cc` = `backdrop × 0.20 + 20`,
   worst case 71), not a light one. (Though per the brief above, prefer no fill at all.)
6. **`blur(<length>)` takes a sigma, not a radius.** `blur(7px)` reduces a 1px star to a peak of
   0.83/255 — invisible, at the cost of a full readback per surface per frame.
7. **The starfield density is ~1.15 stars per 1000 px²** — a typical panel contains ~40 stars. An
   earlier research pass assumed 23× less and wrongly concluded there was nothing to refract.
8. **Nobody else is doing real refraction on the web.** Lovable, Linear, Raycast, Vercel, v0, Cursor
   and Apple's own iOS marketing page were all fetched and grepped: every one is plain `blur()` with
   a border. Zero `feDisplacementMap`. Do not be reassured by copying them — they are not doing it.
9. **Safari 26 ignores `theme-color`** and tints its own toolbar by sampling `background-color` on
   elements near the viewport edges. A transparent root can resolve to **white**, which on a
   true-black phone-first app is the worst available failure and does not reproduce in a simulator.
   Keep an explicit `background: #000` on `html` and `body`.
10. **`prefers-reduced-transparency` is unsupported in every version of iOS Safari**, deliberately,
    on fingerprinting grounds. An in-app toggle is the only real control. There is a
    `html[data-glass="off"]` hook in the stylesheet already; it has no UI yet.

## What the last attempt built, and exactly why it failed

The working tree currently has monochrome + a starfield + an attempt at glass. It is **not committed**.
`git status` will show `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`
modified and `apps/web/public/sky/` untracked.

Three failures, all real:

- **The refracted copy is frozen.** The sky animates via `transform: scale()` on its layers, but the
  lens copies it with a static `background-attachment: fixed` background and no animation. The real
  sky moves; the copy does not. This is the "stagnant artifacts on the glass". It also kills the
  refraction, because a static near-empty patch has nothing to bend.
- **Stars inflate into blobs.** Forward motion was faked by scaling bitmap tiles 1→3.4, so stars grow
  as they approach. Wanted: uniform small points, subtle size variation only.
- **No visible refraction in practice.** The displacement map is derived from the surface's own
  `SourceAlpha` (blur the silhouette, take a signed central difference via two `feColorMatrix` and an
  `feOffset`). Elegant and asset-free, and the grid test proved it bends — but at shipping values
  over this backdrop it does not read.

**The architectural conflict you must solve.** Proper forward motion with uniform point stars needs
real 3D projection — a canvas or WebGL particle field, where each star has x/y/z and is projected as
`x/z, y/z`. But the refraction technique depends on being able to _duplicate the backdrop cheaply in
CSS_, which you cannot do with a canvas. Resolve this deliberately. Options worth evaluating:
render the starfield in WebGL and do the glass in the same WebGL pass; give each glass surface its
own small canvas drawing the same seeded field offset by its position; or find what the shipped
libraries actually do about it. Do not paper over it.

## Constraints that are real

- `pnpm check` must stay green (2,829 tests) — it currently is.
- Hard eager-bundle gate: **150 kB gzip**, enforced in a rolldown plugin in `apps/web/vite.config.ts`,
  and it **fails the build**. Currently at 149.3 kB — about 0.7 kB of headroom. Anything substantial
  must be lazy-loaded (decorative layers are a good candidate — 0 eager bytes) or funded by moving
  something else behind `React.lazy`.
- **CSP forbids every external resource** — no CDN, no remote fonts, no third-party scripts. Inline
  SVG and `data:`/`blob:` URIs are fine.
- Accessibility measured rather than asserted: APCA `Lc ≥ 75` for body text, 24px tap targets,
  visible focus, and everything folds flat under `prefers-reduced-motion`.
- It is a tool used eight hours a day, **mostly on a phone**. iOS Safari matters more than Chrome.
  Anything that repeats visibly, vibrates, or fights legibility fails however good it looks in a
  screenshot. Note WebKit rasterises SVG filters in **software** — cost is O(filter region × primitive
  count), so filter regions matter enormously.
- Never name another AI product or company in any repo file.
- `apps/web/src/fire.ts` is a state machine driven by the real event stream. A high but _still_ flame
  during a running turn means the turn has stalled — no spinner can say that. Whatever you build must
  keep carrying that signal.

## How to work

- **Verify in a real browser and show me what you saw.** Be aware: the built-in Browser pane runs the
  page in a hidden state, which **pauses CSS animations** (`currentTime` advances 0 ms), so you cannot
  judge motion there. Use headless Chromium via Playwright, or ask me to look.
- Prototype standalone before touching product code. I need to be able to open it and watch it.
- Show me options where taste is involved, but have a strong recommendation.
- Tell me honestly what you could not verify — especially anything iOS-specific, which cannot be
  tested from this machine.

## Where to start

Reset or keep the working tree as you prefer — nothing is committed, and `git reset --hard origin/main`
returns to the last clean state. Tell me which you are doing and why.
