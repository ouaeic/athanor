import { useEffect, useId, useRef } from 'react';
import { registerFire } from './fire.js';

/**
 * The mark: a drawing athanor made of itself, with the fire in it still live.
 *
 * It was a hand-drawn vector furnace, and before that a flask. The owner's word for the vector was
 * horrible, and they were right - it was a diagram of the idea rather than a character. This is what
 * they asked for instead: a 1930s rubber-hose cartoon of the alchemist's slow furnace, drawn by this
 * product on a flat chroma-green plate and keyed out, which is exactly the work an owner would come
 * here to have done.
 *
 * Still an `<svg>`, and that is not laziness. Four places mount this and every one of them sizes it
 * from the outside - `.brand-mark svg`, `.brand-mark.large svg`, `.agent-brand-avatar svg` - so the
 * element has to keep being the thing those selectors name. The drawing rides inside it as an
 * `<image>`, which means it is a file in `public/` fetched once and cached, and costs the eager
 * bundle nothing where the vector was bytes in the entry chunk on every load.
 *
 * What a baked drawing does cost is the flame's *height*, which cannot be driven. So the half of the
 * signal that survives is the half that was already carrying most of it: `fire.ts` writes
 * `--draught` on this element exactly as before, `.mark-glow` spends it on the light coming out of
 * the door, and the stylesheet's `cold` and `calling` rules are untouched. The claim that matters is
 * intact - a still glow during a running turn means the run is still, which no spinner can say,
 * because a spinner spins identically through death.
 *
 * The glow sits on the door by measurement rather than by eye: the fire's own pixels in
 * `athanor-mark-512.png` centre at 45.8% across and 68.8% down and span 14% of the drawing, which is
 * where the ellipse below comes from. Regenerate the drawing and that is the measurement to retake.
 * It screens rather than covers, because light from a fire adds to what is behind it.
 */
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
      viewBox="0 0 128 128"
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
      <image className="mark-drawing" href="/brand/athanor-mark-512.png" width="128" height="128" />
      <ellipse
        className="mark-glow"
        cx="58.6"
        cy="88.1"
        rx="27"
        ry="23"
        fill={`url(#${glow})`}
        style={{ mixBlendMode: 'screen' }}
      />
    </svg>
  );
}
