import { useId } from 'react';

/**
 * The mark, drawn rather than photographed.
 *
 * It was a 248 KB raster engraving of a vessel and a blackletter word, rendered at 54px in the
 * sidebar and 108px on the splash. At those sizes the word was mud and the engraving was a grey
 * smear, which is why the stylesheet had grown a `drop-shadow` and a `scale(1.27)` trying to make
 * it legible. The vector it was rendered from has been sitting in `public/icon.svg` all along:
 * a quarter of a kilobyte of it, sharp at any size, and no word to lose.
 *
 * The flame inside the vessel is ember, and it is the only place ember appears while nothing is
 * happening. An athanor is the furnace that holds one low steady flame for as long as the work
 * takes; this is the pilot light.
 *
 * The gradients are given document-unique ids because the mark renders twice on the sign-in screen,
 * and two `<defs>` sharing an id is one gradient serving both - which is invisible until the day
 * one of them is removed.
 */
export function BrandMark({ className }: { className?: string }) {
  const id = useId();
  const vessel = `${id}-vessel`;
  const metal = `${id}-metal`;
  return (
    <svg
      className={className}
      viewBox="0 0 128 128"
      role="img"
      aria-label="athanor"
      focusable="false"
    >
      <defs>
        <radialGradient id={vessel} cx=".28" cy=".18" r=".9">
          <stop stopColor="#303234" />
          <stop offset=".48" stopColor="#17191a" />
          <stop offset="1" stopColor="#090a0b" />
        </radialGradient>
        <linearGradient id={metal} x1="29" y1="22" x2="98" y2="107">
          <stop stopColor="#f7f8f8" />
          <stop offset=".36" stopColor="#a9adb0" />
          <stop offset=".67" stopColor="#f0f1f1" />
          <stop offset="1" stopColor="#73787b" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="126"
        height="126"
        rx="29"
        fill={`url(#${vessel})`}
        stroke="#fff"
        strokeOpacity=".12"
        strokeWidth="2"
      />
      <path
        d="M48 24h32M52 24v20L33 85.5A14 14 0 0 0 45.8 104h36.4A14 14 0 0 0 95 85.5L76 44V24"
        fill="none"
        stroke={`url(#${metal})`}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M41 80h46M54 80c1.5-8.7 4.9-16.2 10-23 5.1 6.8 8.5 14.3 10 23"
        fill="none"
        stroke="var(--ember)"
        strokeWidth="5.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
