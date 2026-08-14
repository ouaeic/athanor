import { useEffect, useId, useRef } from 'react';
import { registerFire } from './fire.js';

/**
 * The mark: a drawing athanor made of itself, with the fire in it still live.
 *
 * It was a hand-drawn vector furnace, and before that a flask. The owner's word for the vector was
 * horrible, and they were right - it was a diagram of the idea rather than a character. This is a
 * hand-painted cel of the alchemist's slow furnace with a fire spirit living in the hearth, drawn by
 * this product on a flat chroma-green plate and keyed out, which is exactly the work an owner would
 * come here to have done.
 *
 * **The flame is a separate layer, and that is the whole point of this file.** The previous baked
 * drawing could not drive the flame's *height*, and height is the half of the signal that matters:
 * `fire.ts` sums arriving events and decays them, so a high, perfectly still flame during a running
 * turn means the turn has stalled - which no spinner can say, because a spinner spins identically
 * through death. `layers.py` cuts the stone and the fire onto one shared canvas so this can hold the
 * background and move the character, the way limited animation does.
 *
 * The stone is greyscale by construction, so the fire is the only colour in the mark and the only
 * colour it contributes to the room around it.
 *
 * Still an `<svg>`, and that is not laziness. Four places mount this and every one sizes it from the
 * outside - `.brand-mark svg`, `.brand-mark.large svg`, `.agent-brand-avatar svg` - so the element
 * has to keep being the thing those selectors name. The drawings ride inside as `<image>`s, which
 * means files in `public/` fetched once and cached, costing the eager bundle nothing.
 */

/** Measured by `layers.py` off the cut itself, and re-reported every time the mark is regenerated. */
const CANVAS = { w: 512, h: 578 };
const FLAME = { x: 0.4969, baseY: 0.8408, topY: 0.4221, width: 0.3945 };

export function BrandMark({ className }: { className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  // Every mark that mounts registers, and every one that goes unregisters: this component is on the
  // sign-in screen twice and in the shell twice more, and a set of detached nodes is a leak that
  // gets written to four times a second.
  useEffect(() => registerFire(svg.current), []);
  // Document-unique, because the mark renders twice on the sign-in screen and two `<defs>` sharing
  // an id is one gradient serving both - invisible until the day one of them is removed.
  const glow = `${useId()}-glow`;

  return (
    <svg
      ref={svg}
      className={className}
      viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`}
      role="img"
      aria-label="athanor"
      focusable="false"
    >
      <defs>
        <radialGradient id={glow} cx=".5" cy=".5" r=".5">
          <stop stopColor="var(--ember)" stopOpacity=".85" />
          <stop offset=".45" stopColor="var(--ember)" stopOpacity=".3" />
          <stop offset="1" stopColor="var(--ember)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* The stone. Held, never moved: it is a building. */}
      <image className="mark-stone" href="/room/hearth.webp" width={CANVAS.w} height={CANVAS.h} />

      {/* The light the fire throws back onto its own arch. Screened, because light from a fire adds
          to what is behind it rather than covering it. */}
      <ellipse
        className="mark-glow"
        cx={CANVAS.w * FLAME.x}
        cy={CANVAS.h * (FLAME.topY + FLAME.baseY) * 0.5}
        rx={CANVAS.w * FLAME.width * 1.5}
        ry={CANVAS.h * (FLAME.baseY - FLAME.topY) * 0.85}
        fill={`url(#${glow})`}
        style={{ mixBlendMode: 'screen' }}
      />

      {/* The fire. Scaled from its own base by `--draught`, so it grows upward the way a flame does
          rather than swelling from its middle. */}
      <image
        className="mark-flame"
        href="/room/flame.webp"
        width={CANVAS.w}
        height={CANVAS.h}
        style={{ transformOrigin: `${FLAME.x * 100}% ${FLAME.baseY * 100}%` }}
      />
    </svg>
  );
}
