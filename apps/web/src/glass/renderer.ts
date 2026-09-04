/**
 * The glass itself: one WebGL2 canvas that draws the room and every surface in front of it.
 *
 * THREE PASSES. Pass A resolves the backdrop into a screen-sized texture - cover-scaled, anchored
 * to the BOTTOM LEFT so the corner the fire lives in is the one corner no aspect ratio can crop,
 * leaning a little away from the pointer - and builds its mip chain. Pass B blits that to the
 * screen. Pass C draws ONE QUAD PER SURFACE, each one bending the backdrop underneath it.
 *
 * WHY A QUAD PER SURFACE RATHER THAN ONE FULLSCREEN PASS. The obvious shape is a single fullscreen
 * shader that finds the nearest surface per pixel, and it collapses the moment there are more than
 * a handful: every pixel pays for every surface, so a settings sheet with sixty controls costs
 * sixty signed-distance evaluations at each of two million pixels whether or not anything is there.
 * Instanced quads invert that - cost becomes the total AREA the surfaces cover, which is bounded by
 * the screen no matter how many of them there are, and a fragment outside its own silhouette simply
 * discards onto the blit that already painted the room.
 *
 * WHY A CANVAS AND NOT CSS. `backdrop-filter: url(#filter)` is Chromium-only, and in WebKit a
 * single `url()` anywhere in the declaration discards the whole operation list - so the blur beside
 * it dies too and the surface goes fully transparent. `CSS.supports()` returns true for it, so
 * there is not even a feature test. Copying the backdrop into each surface and bending that does
 * work in WebKit, but the copy has to be kept in step with a backdrop that moves, and a video
 * cannot be duplicated per surface. Drawing both from one renderer removes the problem rather than
 * solving it: there is no copy, because whatever owns the backdrop also owns the lens.
 *
 * The material is a faithful implementation of the published technique rather than an invention:
 * spherical-cap slope for the direction, an erf sigmoid for the edge falloff, splay to rotate the
 * field square to the nearest edge, a three-way chromatic split, and a directional highlight whose
 * composite blends between adding and multiplying according to the luminance of whatever the pixel
 * actually landed on - which is why the edge answers the room moving behind it instead of sitting
 * there like a painted rim.
 */

export type Surface = {
  /** Centre and half-extent in device pixels, y measured from the bottom. */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  radius: number;
};

/**
 * A pane: one or more surfaces that touch, drawn as a single piece of glass.
 *
 * The members keep their own outlines, but only as SEAMS - a hairline where two of them meet
 * inside the pane. The lens itself belongs to the pane: one dome, one edge, one falloff, computed
 * from the pane's own bounds. That is the difference between a toolbar of six buttons reading as
 * six separate lozenges and reading as one bar with divisions scored into it.
 */
export type Pane = {
  /** Centre and half-extent of the whole pane, in device pixels. */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** Where this pane's members start in the surface list, and how many there are. */
  start: number;
  count: number;
  /** Inside another pane: the lens inverts, so it reads as cut into the glass rather than laid on. */
  inset: boolean;
};

export type Material = {
  /**
   * How thick the glass is, in CSS px.
   *
   * Absolute, not a fraction of the element. Deviation at a surface is set by its slope, and how
   * far that deviation carries the sampled point is set by how much glass the ray still has to
   * cross - so displacement is slope times THICKNESS. Expressing it as a fraction of each
   * element's own size, which is what the published lens does because its lenses are authored one
   * at a time, silently makes small controls out of thin glass and large panes out of thick: a
   * 44px button gets under two pixels of bend and stops refracting at all. Capped per surface
   * against its own half-extent, since a lens cannot be much thicker than it is wide.
   */
  thickness: number;
  /** Anisotropy of the bend, per axis. 1 is isotropic. */
  scaleX: number;
  scaleY: number;
  /** Width in CSS px of the band at the rim across which the bend ramps up. */
  depth: number;
  /** Sag of the spherical cap in CSS px. Zero is a prism: a constant slope. */
  curve: number;
  /** 1 leaves the natural fan; below that the field rotates square to the nearest edge. */
  splay: number;
  chroma: number;
  /** Surface roughness in CSS px. This is the frosting. */
  blur: number;
  /**
   * The share of the frosting that comes from the two SURFACES rather than from the volume between
   * them. Light scatters going in and coming out however thin the glass is, so this share survives
   * at any thickness; the rest grows with path length. It is why an indent frosts less than the
   * pane around it without ever becoming a window.
   */
  blurSurface: number;
  glow: number;
  glowSpread: number;
  glowExp: number;
  edge: number;
  edgeWidth: number;
  edgeExp: number;
  /** Degrees. The direction the highlight faces. */
  specAngle: number;
  specStrength: number;
  lumaLow: number;
  lumaHigh: number;
  /** Pull toward mid-grey: lifts dark backdrops, darkens bright ones. */
  brightness: number;
  /** Ripple amplitude in CSS px. Ours, not the reference's. */
  ripple: number;
  /** How far the room leans away from the pointer, in CSS px at full deflection. */
  parallax: number;
  /**
   * How much glass is left under an inset surface, as a fraction of the pane it is cut into. It
   * governs the optical path and only that: the bend, the scattering and the dispersion.
   *
   * Kept HIGH on purpose. Thinner glass genuinely transmits more clearly, so a deep scoop shows
   * more of the room, more sharply, than the pane around it - and "clearer than its surroundings"
   * and "opening in its surroundings" are the same picture. The depth cue therefore has to come
   * from the rim, which announces a shape, rather than from the transmission, which announces an
   * absence. Take this down and indents start reading as holes punched through.
   */
  insetThickness: number;
  /** Signed edge light: one rim lit, the opposite shaded. This is what reads as raised or sunk. */
  bevel: number;
  /** Width of that lit rim, in CSS px. */
  bevelWidth: number;
  /** Strength of the hairline where two surfaces meet inside one pane. */
  seam: number;
  /** Width of that hairline, in CSS px. */
  seamWidth: number;
  /**
   * Where the fire clip's frame sits in the artwork, in image UV: u0, v0, u1, v1.
   * The clip is a crop of this very picture, so its content lines up by construction.
   */
  fireRect: [number, number, number, number];
};

export const MATERIAL: Material = {
  thickness: 42,
  scaleX: 1,
  scaleY: 1,
  depth: 10,
  curve: 40,
  splay: 1,
  chroma: 0.2,
  blur: 9,
  blurSurface: 0.7,
  glow: 0.1,
  glowSpread: 1,
  glowExp: 1.5,
  edge: 0.25,
  edgeWidth: 3,
  edgeExp: 1.5,
  specAngle: 45,
  specStrength: 1,
  lumaLow: 0.3,
  lumaHigh: 0.7,
  brightness: 0.18,
  ripple: 26,
  parallax: 14,
  insetThickness: 0.82,
  bevel: 0.28,
  bevelWidth: 9,
  seam: 0.5,
  seamWidth: 1.25,
  fireRect: [0, 0.6174, 0.2871, 1]
};

const VERT_FULLSCREEN = `#version 300 es
in vec2 a;
void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG_BACKDROP = `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform vec2 uImgSize;
uniform vec2 uRes;
uniform vec2 uShift;
uniform float uSlack;
uniform sampler2D uFireTex;
uniform vec4 uFireRect;   // u0, v0, u1, v1 of the clip within the picture
uniform float uFireOn;
out vec4 o;
void main(){
  /* Cover, anchored bottom-left: overflow is cropped off the top and the right, so the corner the
     fire lives in is pinned whatever shape the window is.

     uSlack scales the room a hair beyond cover. Anchoring alone leaves overflow on two sides only,
     and a lean has to have somewhere to go on all four - without the slack the room would hit its
     own edge and show a seam the moment the pointer moved the wrong way. */
  float s  = max(uRes.x / uImgSize.x, uRes.y / uImgSize.y) * uSlack;
  vec2  sz = uImgSize * s;
  vec2  base = gl_FragCoord.xy - uShift - vec2(0.0, (uSlack - 1.0) * uRes.y * 0.5);
  vec2 uv = clamp(vec2(base.x / sz.x, 1.0 - base.y / sz.y), 0.0, 1.0);
  vec3 col = texture(uImg, uv).rgb;

  /* THE ONLY THING THAT MOVES.
     Everything else in the room is a still photograph and stays one - which is the whole reason
     this works where generating the room did not: nothing can drift, because nothing else is being
     drawn. What moves is the light, modulated where the fire already is, so it is the painting's
     own warmth breathing rather than a glow pasted on top of it.

     Two terms with different reach and a small lag between them: the aperture swings hardest and
     immediately, and the light it throws across the floor and the copper swings less and arrives
     late, because it is the same fire seen at one remove.

     It sits in the BACKDROP pass on purpose, so every pane in front of it refracts and frosts the
     flicker exactly as it does the rest of the room. */
  /* The clip, drawn where it belongs. It is a crop of this same picture, so it goes in its own
     rectangle and replaces what is under it - the two are the same view of the same corner. */
  if (uFireOn > 0.5 &&
      uv.x >= uFireRect.x && uv.x <= uFireRect.z &&
      uv.y >= uFireRect.y && uv.y <= uFireRect.w){
    vec2 fu = (uv - uFireRect.xy) / (uFireRect.zw - uFireRect.xy);
    col = texture(uFireTex, fu).rgb;
  }

  o = vec4(col, 1.0);
}`;

const FRAG_BLIT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
out vec4 o;
void main(){ o = vec4(textureLod(uSrc, gl_FragCoord.xy / uRes, 0.0).rgb, 1.0); }`;

const VERT_SURFACE = `#version 300 es
in vec2 aCorner;
in vec4 aPane;   // centre.xy, half-extent.xy of the whole pane
in vec4 aDome;   // spherical cap constants for the pane
in vec4 aMeta;   // member start, member count, inset flag, unused
uniform vec2 uRes;
out vec4 vPane;
out vec4 vDome;
out vec4 vMeta;
void main(){
  vPane = aPane;
  vDome = aDome;
  vMeta = aMeta;
  // One pixel of margin so the antialiased silhouette is never clipped by its own quad.
  vec2 px = aPane.xy + aCorner * (aPane.zw + 1.0);
  gl_Position = vec4((px / uRes) * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_SURFACE = `#version 300 es
precision highp float;

uniform sampler2D uSrc;
uniform vec2  uRes;
uniform float uMaxLod;

uniform vec2  uScale;
uniform float uThickPx;
uniform float uDepth;
uniform float uCurve;
uniform float uSplay;
uniform float uChroma;
uniform float uBlur;

uniform float uGlow;
uniform float uGlowSpread;
uniform float uGlowExp;
uniform float uEdge;
uniform float uEdgeW;
uniform float uEdgeExp;
uniform float uSpecAng;
uniform float uSpecStr;
uniform float uLumaLo;
uniform float uLumaHi;
uniform float uBright;

uniform vec4  uRip;
uniform float uRipAmp;

uniform sampler2D uMembers;   // one column per surface: row 0 rect, row 1 radius
uniform float uSeam;
uniform float uSeamW;
uniform float uBevel;
uniform float uBevelW;
uniform float uThick;
uniform float uBlurSurf;

in vec4 vPane;
in vec4 vDome;
in vec4 vMeta;

const float SQRT2 = 1.41421356;

out vec4 o;

float sdBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float erfa(float x){ return tanh(1.7724538509 * x); }

/* The exact surface slope of a spherical cap, tan(asin(r/R)). R and the normalising scale depend
   only on the surface size and the sag, so they are computed once per surface on the CPU. */
float domeGrad(float r, float R, float s){
  float n = min(r, 0.999 * R);
  return (n / sqrt(max(R * R - n * n, 1e-4))) * s;
}

vec3 srcAt(vec2 px, float lod){
  return textureLod(uSrc, px / uRes, clamp(lod, 0.0, uMaxLod)).rgb;
}

void main(){
  vec2  p     = gl_FragCoord.xy;
  vec2  half_ = vPane.zw;
  vec2  q     = p - vPane.xy;

  /* The pane's silhouette is the union of its members, so the nearest member IS the pane at this
     pixel. The SECOND nearest is what makes a join visible: where two members are equally close and
     both contain the pixel, they meet, and that is where the seam goes. One loop gives both. */
  int   start = int(vMeta.x);
  int   count = int(vMeta.y);
  float d1 = 1e9, d2 = 1e9;
  for (int i = 0; i < count; i++){
    vec4  r  = texelFetch(uMembers, ivec2(start + i, 0), 0);
    float rr = texelFetch(uMembers, ivec2(start + i, 1), 0).x;
    float di = sdBox(p - r.xy, r.zw, rr);
    if (di < d1){ d2 = d1; d1 = di; } else if (di < d2){ d2 = di; }
  }

  float d = d1;
  // Outside the pane this fragment has nothing to say, and the blit underneath has already
  // painted the room there.
  if (d > 0.0) discard;

  float ax = abs(q.x), ay = abs(q.y);

  vec2 g;
  if (uCurve > 0.01)
    g = vec2(sign(q.x) * domeGrad(ax, vDome.x, vDome.z),
             sign(q.y) * domeGrad(ay, vDome.y, vDome.w));
  else
    g = clamp(vec2(q.x / half_.x, q.y / half_.y), -1.0, 1.0);

  /* An inset surface is not a second piece of glass laid into the first. It is the SAME pane with
     less of it left: a dish scooped out of the face.

     Two consequences, and they are different things. The wall of the scoop slopes INWARD and down,
     where a pane's rim slopes outward and down - opposite tilt, so light bends the opposite way and
     the rim catches light from the opposite quarter. That is direction, and it does not care how
     deep the scoop is. Separately, the scoop only removes PART of the pane's thickness, so its wall
     drops less over the same width: a gentler slope, less deviation, and less glass left under it
     for that deviation to carry through. That is magnitude, and it is what thickness governs.

     Direction from the geometry, magnitude from what is left. Confusing the two is how this ends up
     either as a bulge that reads as raised, or as a hole with no distortion in it at all. */
  float inset = vMeta.z;
  float thick = mix(1.0, uThick, inset);
  float dish  = mix(1.0, -1.0, inset);

  /* Splay. Proximity in y attenuates the x component and vice versa, then the magnitude is
     restored - so this ROTATES the field square to the nearest edge rather than weakening it. */
  if (uSplay < 0.999){
    float L = 0.5 * min(half_.x, half_.y);
    float B = L > 0.0 ? 1.0 / L : 0.0;
    float ey = max(0.0, 1.0 - (half_.y - ay) * B) * (1.0 - uSplay);
    float ex = max(0.0, 1.0 - (half_.x - ax) * B) * (1.0 - uSplay);
    if (ey > 0.001 || ex > 0.001){
      vec2  g0 = g;
      g = vec2(g.x * (1.0 - ey), g.y * (1.0 - ex));
      float l1 = length(g);
      if (l1 > 0.001) g *= length(g0) / l1;
    }
  }

  /* The edge falloff: a sigmoid of width uDepth centred on the surface shrunk by uDepth. Flat
     through the middle, ramping to full across a band at the rim, and smooth everywhere - which is
     what stops the lens having a slope no sampling rate can resolve. */
  float depth = max(min(uDepth, min(half_.x, half_.y) * 0.9), 1.0);
  vec2  inner = max(half_ - depth, vec2(0.0));
  float ir    = clamp(min(half_.x, half_.y) * 0.35, 0.0, min(inner.x, inner.y));
  // Measured against the PANE's silhouette, not the member's, so a join has no edge of its own.
  float fall  = 0.5 * (1.0 + erfa((d + depth) / (depth * SQRT2)));

  /* Slope times thickness. The cap keeps a lens from being much thicker than it is wide, which is
     what stops a small control sampling the room from entirely outside itself. */
  float thickPx = min(uThickPx, min(half_.x, half_.y) * 0.8) * thick;
  vec2  off = -uScale * thickPx * g * fall * dish;

  // A decaying travelling ring on the same offset field, so a touch refracts the room rather than
  // tinting the surface. This one is ours; everything else here is the published material.
  if (uRip.w > 0.0 && uRipAmp > 0.0){
    vec2  rv = p - uRip.xy;
    float rd = length(rv) + 1e-4;
    off += (rv / rd) * uRipAmp
         * exp(-uRip.z * 2.3) * exp(-rd * 0.0045)
         * sin(rd * 0.085 - uRip.z * 15.0);
  }

  /* Scattering happens at both faces and again along the way between them. The face part does not
     care how much glass is behind it; the path part does. So an indent frosts less than the pane it
     is cut into, but never stops frosting - which is the difference between thinner glass and a
     hole cut through it. */
  float lod = log2(max(uBlur * mix(uBlurSurf, 1.0, thick), 1.0));

  float chroma = uChroma * thick;
  vec3 col;
  if (chroma > 0.001)
    col = vec3(srcAt(p + off * (1.0 + chroma * 0.2), lod).r,
               srcAt(p + off * (1.0 + chroma * 0.1), lod).g,
               srcAt(p + off, lod).b);
  else
    col = srcAt(p + off, lod);

  /* The highlight. Its PATTERN is a directional dot product across the face: a broad wash gated by
     spread, and a thin band uEdgeW pixels inside the silhouette that brightens where the border
     faces the light. Its EFFECT is not fixed - the composite blends between ADDING it and
     MULTIPLYING by it according to the luminance of the room this pixel landed on, so the edge
     answers what passes behind it. 0.498 is not a fudge: the published version carries this in a
     byte channel as 127x+128 and composites (channel - 128/255), so the light it adds is 127/255 of
     the term, and adding the raw term is twice as bright as the material being copied. */
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  vec2  L    = vec2(cos(uSpecAng), sin(uSpecAng));
  vec2  n    = clamp(vec2(q.x / half_.x, q.y / half_.y), -1.0, 1.0);
  // The published highlight takes the ABSOLUTE dot product, so both facing rims light equally and
  // the shape reads as symmetrical - which is why reversing the light direction on an inset surface
  // changed precisely nothing. Kept for the glow and the rim, because that is the material.
  float t    = abs(dot(n, L));
  float glow = uGlow * pow(clamp((t - (1.0 - uGlowSpread) * SQRT2)
                                 / max(uGlowSpread * SQRT2, 1e-3), 0.0, 1.0), uGlowExp) * fall;
  float edge = uEdge * max(0.0, 1.0 + d / uEdgeW) * pow(t, uEdgeExp);
  float spec = 0.498 * min(1.0, glow + edge) * uSpecStr;

  float blend = smoothstep(min(uLumaLo, uLumaHi), max(uLumaLo, uLumaHi), luma);
  col = max(mix(col + spec, col * (1.0 - spec), blend), vec3(0.0));
  col += (0.5 - luma) * uBright;

  /* THE BEVEL, and the whole of what makes something read as sunk rather than raised.
     A SIGNED dot product this time: the rim whose outward normal faces the light gains light, the
     rim opposite loses it. Raised and sunk are the same surface with that pair swapped, which is
     why one multiplication by 'flip' does it - and why nothing short of an asymmetric term could,
     since a symmetric highlight looks identical either way up. */
  if (uBevel > 0.0){
    float lip = max(0.0, 1.0 + d / uBevelW);
    col += uBevel * lip * lip * dot(n, L) * dish;
  }

  /* The seam. Where the two nearest members are equally close, they meet - so the difference
     between those distances is the distance to their join. A pane of six buttons is one lens with
     five lines scored into it, rather than six lenses touching. */
  if (uSeam > 0.0 && count > 1){
    float join = smoothstep(uSeamW, 0.0, abs(d2 - d1));
    col *= 1.0 - uSeam * join * 0.5;
  }

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

const compile = (gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram => {
  const make = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, make(gl.VERTEX_SHADER, vert));
  gl.attachShader(program, make(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  return program;
};

const locations = (gl: WebGL2RenderingContext, program: WebGLProgram, names: string[]): Uniforms =>
  Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));

/**
 * The spherical cap for one surface. The scale normalises the MEAN slope across the half-extent to
 * 0.5, so raising the curvature redistributes where the bending happens without changing how much
 * bending there is in total - which is what makes it a shape control rather than a strength one.
 */
const dome = (sag: number, hx: number, hy: number): [number, number, number, number] => {
  const a = Math.max(0.01, Math.min(sag, Math.min(hx, hy) - 1));
  const meanSlope = (radius: number, half: number): number => {
    let acc = 0;
    for (let n = 0; n <= 32; n++) {
      const t = (n / 32) * half;
      const v = t / Math.sqrt(Math.max(radius * radius - t * t, 1e-6));
      acc += n === 0 || n === 32 ? 0.5 * v : v;
    }
    return acc / 32;
  };
  const rx = (hx * hx + a * a) / (2 * a);
  const ry = (hy * hy + a * a) / (2 * a);
  const mx = meanSlope(rx, hx);
  const my = meanSlope(ry, hy);
  return [rx, ry, mx > 0 ? 0.5 / mx : 1, my > 0 ? 0.5 / my : 1];
};

export type Renderer = {
  resize: (width: number, height: number, dpr: number) => void;
  draw: (
    source: TexImageSource,
    surfaces: readonly Surface[],
    panes: readonly Pane[],
    now: number,
    fire: TexImageSource | null
  ) => void;
  ripple: (x: number, y: number) => void;
  /** Where the pointer is, as -1..1 about the centre of the window. */
  lean: (x: number, y: number) => void;
  destroy: () => void;
};

export const createRenderer = (
  gl: WebGL2RenderingContext,
  material: Material = MATERIAL
): Renderer => {
  const progBackdrop = compile(gl, VERT_FULLSCREEN, FRAG_BACKDROP);
  const progBlit = compile(gl, VERT_FULLSCREEN, FRAG_BLIT);
  const progSurface = compile(gl, VERT_SURFACE, FRAG_SURFACE);

  const uA = locations(gl, progBackdrop, [
    'uImg',
    'uImgSize',
    'uRes',
    'uShift',
    'uSlack',
    'uFireTex',
    'uFireRect',
    'uFireOn'
  ]);
  const uBlit = locations(gl, progBlit, ['uSrc', 'uRes']);
  const uC = locations(gl, progSurface, [
    'uSrc',
    'uMembers',
    'uRes',
    'uMaxLod',
    'uScale',
    'uDepth',
    'uCurve',
    'uSplay',
    'uChroma',
    'uBlur',
    'uGlow',
    'uGlowSpread',
    'uGlowExp',
    'uEdge',
    'uEdgeW',
    'uEdgeExp',
    'uSpecAng',
    'uSpecStr',
    'uLumaLo',
    'uLumaHi',
    'uBright',
    'uRip',
    'uRipAmp',
    'uSeam',
    'uSeamW',
    'uBevel',
    'uBevelW'
  ]);

  // A fullscreen triangle for the two whole-screen passes.
  const fullVao = gl.createVertexArray();
  gl.bindVertexArray(fullVao);
  const fullBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aFull = gl.getAttribLocation(progBackdrop, 'a');
  gl.enableVertexAttribArray(aFull);
  gl.vertexAttribPointer(aFull, 2, gl.FLOAT, false, 0, 0);

  // A unit quad plus one instance's worth of geometry per surface.
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  const cornerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(progSurface, 'aCorner');
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

  const instanceBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
  /** rect(4) + dome(4) + meta(4), interleaved, per surface. */
  const STRIDE = 12;
  for (const [name, offset] of [
    ['aPane', 0],
    ['aDome', 4],
    ['aMeta', 8]
  ] as const) {
    const loc = gl.getAttribLocation(progSurface, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, STRIDE * 4, offset * 4);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);

  const fireTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fireTex);
  for (const [key, value] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, key, value);
  const sourceTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sourceTex);
  for (const [key, value] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, key, value);

  const screenTex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let width = 1;
  let height = 1;
  let dpr = 1;
  let maxLod = 1;

  let instances = new Float32Array(STRIDE * 32);
  /* The members live in a texture rather than in uniforms: a pane needs to walk its own members
     per fragment, the count is unbounded, and a uniform array would have to be sized for the worst
     case and uploaded whole every frame. RGBA32F read with texelFetch - no filtering, so no
     extension is needed for it. */
  let members = new Float32Array(64 * 2 * 4);
  let memberCap = 64;
  const memberTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, memberTex);
  for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
    gl.texParameteri(gl.TEXTURE_2D, key, gl.NEAREST);
  for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, key, gl.CLAMP_TO_EDGE);
  let rip: [number, number, number] = [0, 0, 0];
  let ripAt = -1e9;
  let leanX = 0;
  let leanY = 0;

  const resize = (nextWidth: number, nextHeight: number, nextDpr: number): void => {
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    gl.bindTexture(gl.TEXTURE_2D, screenTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, screenTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    maxLod = Math.floor(Math.log2(Math.max(width, height)));
  };

  const sourceSize = (source: TexImageSource): [number, number] => {
    if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
    if (source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight];
    const sized = source as { width?: number; height?: number };
    return [sized.width ?? 1, sized.height ?? 1];
  };

  const draw = (
    source: TexImageSource,
    surfaces: readonly Surface[],
    panes: readonly Pane[],
    now: number,
    fire: TexImageSource | null
  ): void => {
    const [sw, sh] = sourceSize(source);
    if (sw < 2 || sh < 2) return;

    const count = panes.length;
    if (instances.length < count * STRIDE) instances = new Float32Array(count * STRIDE * 2);
    for (let i = 0; i < count; i++) {
      const pane = panes[i]!;
      const at = i * STRIDE;
      instances[at] = pane.cx;
      instances[at + 1] = pane.cy;
      instances[at + 2] = pane.hw;
      instances[at + 3] = pane.hh;
      instances.set(dome(material.curve * dpr, pane.hw, pane.hh), at + 4);
      instances[at + 8] = pane.start;
      instances[at + 9] = pane.count;
      instances[at + 10] = pane.inset ? 1 : 0;
    }

    if (surfaces.length > memberCap) {
      memberCap = surfaces.length * 2;
      members = new Float32Array(memberCap * 2 * 4);
    }
    for (let i = 0; i < surfaces.length; i++) {
      const s = surfaces[i]!;
      members[i * 4] = s.cx;
      members[i * 4 + 1] = s.cy;
      members[i * 4 + 2] = s.hw;
      members[i * 4 + 3] = s.hh;
      members[(memberCap + i) * 4] = s.radius;
    }
    gl.bindTexture(gl.TEXTURE_2D, memberTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, memberCap, 2, 0, gl.RGBA, gl.FLOAT, members);

    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    // Pass A - the room, into the texture, then its mip chain.
    gl.bindVertexArray(fullVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(progBackdrop);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(uA.uImg!, 0);
    gl.uniform2f(uA.uImgSize!, sw, sh);
    gl.uniform2f(uA.uRes!, width, height);
    // The room leans AWAY from the pointer, which is what reads as depth: a window you are moving
    // past shows you more of the far side, not less.
    gl.uniform2f(uA.uShift!, -leanX * material.parallax * dpr, leanY * material.parallax * dpr);
    gl.uniform1f(uA.uSlack!, 1 + (2 * material.parallax * dpr) / Math.max(height, 1));
    gl.uniform4f(uA.uFireRect!, ...material.fireRect);
    gl.uniform1f(uA.uFireOn!, fire ? 1 : 0);
    if (fire) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fireTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fire);
      gl.uniform1i(uA.uFireTex!, 1);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindTexture(gl.TEXTURE_2D, screenTex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // Pass B - the room onto the screen, untouched.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(progBlit);
    gl.bindTexture(gl.TEXTURE_2D, screenTex);
    gl.uniform1i(uBlit.uSrc!, 0);
    gl.uniform2f(uBlit.uRes!, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (count === 0) return;

    // Pass C - one quad per surface, in document order, so a sheet lands over what it covers.
    const age = (now - ripAt) / 1000;
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);
    gl.useProgram(progSurface);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, screenTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, memberTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uC.uSrc!, 0);
    gl.uniform1i(uC.uMembers!, 1);
    gl.uniform1f(uC.uSeam!, material.seam);
    gl.uniform1f(uC.uSeamW!, material.seamWidth * dpr);
    gl.uniform1f(uC.uBevel!, material.bevel);
    gl.uniform1f(uC.uBevelW!, material.bevelWidth * dpr);
    gl.uniform1f(uC.uThick!, material.insetThickness);
    gl.uniform1f(uC.uBlurSurf!, material.blurSurface);
    gl.uniform2f(uC.uRes!, width, height);
    gl.uniform1f(uC.uMaxLod!, maxLod);
    gl.uniform2f(uC.uScale!, material.scaleX, material.scaleY);
    gl.uniform1f(uC.uThickPx!, material.thickness * dpr);
    gl.uniform1f(uC.uDepth!, material.depth * dpr);
    gl.uniform1f(uC.uCurve!, material.curve * dpr);
    gl.uniform1f(uC.uSplay!, material.splay);
    gl.uniform1f(uC.uChroma!, material.chroma);
    gl.uniform1f(uC.uBlur!, material.blur * dpr);
    gl.uniform1f(uC.uGlow!, material.glow);
    gl.uniform1f(uC.uGlowSpread!, material.glowSpread);
    gl.uniform1f(uC.uGlowExp!, material.glowExp);
    gl.uniform1f(uC.uEdge!, material.edge);
    gl.uniform1f(uC.uEdgeW!, material.edgeWidth * dpr);
    gl.uniform1f(uC.uEdgeExp!, material.edgeExp);
    gl.uniform1f(uC.uSpecAng!, (material.specAngle * Math.PI) / 180);
    gl.uniform1f(uC.uSpecStr!, material.specStrength);
    gl.uniform1f(uC.uLumaLo!, material.lumaLow);
    gl.uniform1f(uC.uLumaHi!, material.lumaHigh);
    gl.uniform1f(uC.uBright!, material.brightness);
    gl.uniform4f(uC.uRip!, rip[0], rip[1], age, age < 2.5 ? rip[2] : 0);
    gl.uniform1f(uC.uRipAmp!, material.ripple * dpr);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  };

  return {
    resize,
    draw,
    ripple: (x, y) => {
      rip = [x, y, 1];
      ripAt = performance.now();
    },
    lean: (x, y) => {
      leanX = x;
      leanY = y;
    },
    destroy: () => {
      for (const program of [progBackdrop, progBlit, progSurface]) gl.deleteProgram(program);
      gl.deleteTexture(sourceTex);
      gl.deleteTexture(memberTex);
      gl.deleteTexture(fireTex);
      gl.deleteTexture(screenTex);
      gl.deleteFramebuffer(fbo);
      gl.deleteBuffer(fullBuf);
      gl.deleteBuffer(cornerBuf);
      gl.deleteBuffer(instanceBuf);
      gl.deleteVertexArray(fullVao);
      gl.deleteVertexArray(quadVao);
    }
  };
};
