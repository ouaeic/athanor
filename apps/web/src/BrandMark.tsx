import { useEffect, useId, useRef } from 'react';
import { registerFire } from './fire.js';

/**
 * The mark, drawn rather than photographed.
 *
 * It was a flask, and a flask is the wrong object. An athanor is not glassware: it is the
 * alchemist's slow furnace, the "Piger Henricus" - a squat brick-and-iron tower with a domed cap,
 * an arched fire door and a chimney, built to hold one low fire steady for weeks without going out.
 * That endurance is the whole idea of this product, and the vessel said none of it.
 *
 * So the mark is the furnace: the brick mass, the iron that holds it together, and the door with
 * the fire in it. The fire is ember, and it is the only place ember appears while nothing is
 * happening - the pilot light of a machine still lit while the owner is elsewhere.
 *
 * Drawn for the small sizes rather than the large one. It renders at 54px in the sidebar and 32px
 * as a favicon, so brick courses, a curl of smoke and the rubber-hose face this was sketched with
 * are all absent: each of them is mud below about 40px, and the face in particular read as alarm
 * rather than the calm it was meant to have. What survives all the way down to 20px is a squat
 * silhouette and one bright shape, which is the whole of what a mark owes you.
 *
 * Two metals, because they are doing different jobs. `iron` is the structure - chimney, band,
 * plinth - and is deliberately dim: drawn bright it became a white brim across the dome and the
 * object stopped reading as masonry. `metal` is only the door frame, where the brightness is
 * earned, because it is what throws the fire forward.
 *
 * Both were blue-grey until the interface went warm, and a cool mark inside a bronze rim reads as
 * a mistake. They are warmed at the same lightness they had, so the specular jump that makes them
 * read as struck metal rather than more masonry is unchanged - that contrast between stops is what
 * carries the material, not the hue. Iron sits near the neutral axis, as blackened steel does;
 * the door frame is frankly warm, because it is the one surface in the drawing with a fire on it.
 *
 * The gradients are given document-unique ids because the mark renders twice on the sign-in screen,
 * and two `<defs>` sharing an id is one gradient serving both - which is invisible until the day
 * one of them is removed.
 *
 * Three classes and a ref are the whole of what turns the drawing into an instrument: `fire.ts`
 * writes `--draught` on this element and the stylesheet spends it on the flame's scale and the
 * glow's opacity. Nothing about the drawing changes, because CSS beats a presentation attribute -
 * the inline `fill` and `stroke` below are overridable by the state rules without being touched.
 */
export function BrandMark({ className }: { className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  // Every mark that mounts registers, and every one that goes unregisters: this component is on
  // the sign-in screen twice and in the shell twice more, and a set of detached nodes is a leak
  // that gets written to four times a second.
  useEffect(() => registerFire(svg.current), []);
  const id = useId();
  const tile = `${id}-tile`;
  const brick = `${id}-brick`;
  const iron = `${id}-iron`;
  const metal = `${id}-metal`;
  const glow = `${id}-glow`;
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
        <radialGradient id={tile} cx=".28" cy=".18" r=".9">
          <stop stopColor="#2b2724" />
          <stop offset=".48" stopColor="#171412" />
          <stop offset="1" stopColor="#0a0908" />
        </radialGradient>
        <linearGradient id={brick} x1="34" y1="52" x2="96" y2="106" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6b503e" />
          <stop offset=".55" stopColor="#48362a" />
          <stop offset="1" stopColor="#2c211a" />
        </linearGradient>
        <linearGradient id={iron} x1="30" y1="28" x2="98" y2="108" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a39a92" />
          <stop offset=".45" stopColor="#77706a" />
          <stop offset="1" stopColor="#514c47" />
        </linearGradient>
        <linearGradient id={metal} x1="44" y1="84" x2="84" y2="108" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fdf5ee" />
          <stop offset=".5" stopColor="#c2b4a6" />
          <stop offset="1" stopColor="#867b72" />
        </linearGradient>
        {/* The heat the door lets out. It is what makes the mark look lit rather than drawn. */}
        <radialGradient id={glow} cx=".5" cy=".5" r=".5">
          <stop stopColor="var(--ember)" stopOpacity=".55" />
          <stop offset=".6" stopColor="var(--ember)" stopOpacity=".16" />
          <stop offset="1" stopColor="var(--ember)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect
        x="1"
        y="1"
        width="126"
        height="126"
        rx="29"
        fill={`url(#${tile})`}
        stroke="#fff"
        strokeOpacity=".12"
        strokeWidth="2"
      />

      {/* Chimney first, so the dome overlaps its foot and it reads as seated in the cap. */}
      <path d="M54 29h20v7H54z" fill={`url(#${iron})`} />
      <path d="M57 34h14v24H57z" fill={`url(#${iron})`} />

      <path d="M26 104 L31 70 C31 50 97 50 97 70 L102 104 Z" fill={`url(#${brick})`} />
      {/* Butt caps, not round: a rounded band overhangs the brick and becomes a brim. */}
      <path d="M30.6 74.5h66.8" fill="none" stroke={`url(#${iron})`} strokeWidth="5" />

      <ellipse className="mark-glow" cx="64" cy="93" rx="34" ry="28" fill={`url(#${glow})`} />

      <path
        className="mark-door"
        d="M48 104V90c0-16 32-16 32 0v14Z"
        fill="#0b0908"
        stroke={`url(#${metal})`}
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path
        className="mark-flame"
        d="M64 82c6 8.5 9.5 14.5 9.5 19 0 5.4-4.2 9-9.5 9s-9.5-3.6-9.5-9c0-4.5 3.5-10.5 9.5-19Z"
        fill="var(--ember)"
      />

      <path
        d="M26 107.5h76"
        fill="none"
        stroke={`url(#${iron})`}
        strokeWidth="6"
        strokeLinecap="round"
      />
    </svg>
  );
}
