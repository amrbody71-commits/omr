/* core.glsl.js — THE PILLAR: the two programs of the column of pure light
   on the axis (js/core.js builds the geometry and owns the uniforms).

   ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────
   The previous core was solid geometry — a dark-glass shaft with machined
   collars — and solid geometry with visible shading reads as a CG render.
   The reference's central presence is volumetric and luminous: LIGHT, not
   object. So nothing here has a diffuse surface, a key light, a specular
   highlight, or a silhouette. There are only light phenomena — radial
   falloff, striation, dust, a scanning band — every one of which ends in
   a smooth fade to nothing that the bloom and grain downstream (js/post.js)
   can chew on. The shells are geometry only in the sense that a movie
   screen is: carriers for a falloff function.

   ── THE TWO PROGRAMS ─────────────────────────────────────────────────
     BEAM   1–3 nested coaxial open cylinders merged into ONE draw call
            (per-shell character rides in the aShell vertex attribute).
            Brightness is a pure function of N·V: for a cylinder of glow,
            the chord a view ray cuts through the volume is ∝ facing, so
            facing² is the soft physical lobe — 1 on the sightline through
            the axis, exactly 0 at the silhouette. NO edge exists anywhere.
            Slow vertical striation (the light-rays plate, or procedural
            noise when it is absent) falls DOWNWARD at a different rate on
            each shell — the parallax that makes nested gradients read as
            a volume. The YEAR BAND — a gaussian in height, era-coloured —
            rides the archive scale as a scanner line living inside the
            column.
     DUST   one Points draw of tiny motes drifting very slowly inside the
            column, brightest where the beam is brightest, igniting as the
            year band sweeps through them. All motion is seed + uTime in
            the vertex shader — the CPU never touches a mote. Dust is what
            makes the light read as illuminated AIR instead of a gradient.

   ── THE SCROLL THAT CANNOT POP ───────────────────────────────────────
   light-rays.png is not vertically tileable (its source blob sits at the
   top), so the beam samples TWO copies half a period apart and crossfades
   with triangle weights (w1 + w2 ≡ 1): each copy fades to zero weight
   before its fract() wraps, so the striation translates downward forever
   with no seam and no pop. The v coordinate stays inside [0.14, 0.88] —
   below the source blob, above the empty tail. When the plate is absent
   the procedural path scrolls natively: features live at constant
   (y + t·flow), which descends at exactly flow world-units per second.

   ── SEAM DISCIPLINE ──────────────────────────────────────────────────
   Angular inputs are either the cylinder's own uv.x (duplicated seam
   vertices sample identical texels under REPEAT wrapping at an integer
   multiplier) or the unit-circle vector normalize(worldPos.xz) fed to
   snoise2 — both continuous all the way around. No atan, no ±π jump.

   Colour is written in linear-sRGB: these programs run before the ACES +
   sRGB transform (js/post.js owns that, once, at the end of the chain).
   fog is OFF on both materials; depthFade() carries the receding-into-
   the-distance manners by hand — additive light must fade toward NOTHING,
   never toward the fog colour (mixing to fog would ADD haze light).
   Precision is never re-declared — three's prefix already does it.

   Defines injected by js/core.js (single source of truth for the scale):
     ARCH_TOP, ARCH_SPAN         the archive scale (y = 9 → 9 − 18·smooth)
     BAND_SIGMA                  the year band's gaussian sigma
     HALF_H, END_FADE_IN         beam half-height + where the end fade starts
     DUST_H, DUST_HALF_H,        the dust column's own height envelope
     DUST_FADE_IN, DUST_GAIN     …and its master brightness */

import { glslNoiseCommon, glslSnoise2 } from './chunks.glsl.js';

/* ------------------------------------------------------------------ */
/* shared by both programs                                             */
/* ------------------------------------------------------------------ */

/* The archive scale never moves — the spiral moves against it — so the
   era gradient along the column is a fixed timeline. js/core.js writes
   ONE height per frame (uBandY) to say where in the life you are. */
const pillarShared = /* glsl */ `
/* palette, pre-converted to linear-sRGB */
const vec3 C_GOLD  = vec3(1.0, 0.8148, 0.6276);   // #FFE9C4 near-white gold
const vec3 C_AMBER = vec3(1.0, 0.4793, 0.1301);   // #FFB865 lamplight amber

uniform float uTime;
uniform float uBandY;        // world height of the year band (the marker)
uniform vec3 uEraColors[6];
uniform vec3 uEraTint;
uniform float uFogNear;
uniform float uFogFar;

/* The era of a point on the scale, as a tent-basis blend of the six tints.
   Constant indices only — dynamic indexing of a uniform array is not
   guaranteed in GLSL ES 1.00 (js/shaders/mist.glsl.js carries the same
   note and the same unrolled form). */
vec3 eraColorAt(float t) {
  float e = clamp(t, 0.0, 1.0) * 5.0;
  vec3 c = uEraColors[0] * max(0.0, 1.0 - abs(e));
  c += uEraColors[1] * max(0.0, 1.0 - abs(e - 1.0));
  c += uEraColors[2] * max(0.0, 1.0 - abs(e - 2.0));
  c += uEraColors[3] * max(0.0, 1.0 - abs(e - 3.0));
  c += uEraColors[4] * max(0.0, 1.0 - abs(e - 4.0));
  c += uEraColors[5] * max(0.0, 1.0 - abs(e - 5.0));
  return c;
}

/* world height → position in the life (0 = birth, at the top) */
float archiveT(float y) {
  return clamp((ARCH_TOP - y) * (1.0 / ARCH_SPAN), 0.0, 1.0);
}

/* THE YEAR BAND: a gaussian of light in height, riding uBandY. At its
   centre archiveT(uBandY) IS the current progress, so the tent blend
   below hands back exactly the era you are in — and interpolates BY
   HEIGHT across the band's own thickness when a boundary crosses it. */
float bandAt(float y) {
  float d = (y - uBandY) * (1.0 / BAND_SIGMA);
  return exp(-d * d);
}

/* …and its colour, breathed toward the ledger's live tint so the band
   can never disagree with the world grade (js/eras.js writes uEraTint). */
vec3 bandColorAt(float y) {
  return mix(eraColorAt(archiveT(y)), uEraTint, 0.30);
}

/* THE BREATH: whole-pillar brightness, ±8% on a 9-second period
   (0.6981317 = 2π/9). uTime freezes under prefers-reduced-motion and
   js/core.js seeds it at exactly one period, so a frozen breath holds
   at precisely 1.0 — while the band keeps tracking: it is information. */
float breath() {
  return 1.0 + 0.08 * sin(uTime * 0.6981317);
}

/* Additive depth manners (js/thread.js): fade toward NOTHING with view
   depth, never toward the fog colour. uFogNear/uFogFar are written from
   the era ledger every frame because material.fog is false here. */
float depthFade(float d) {
  return 1.0 - smoothstep(uFogNear, uFogFar, d) * 0.9;
}
`;

/* ------------------------------------------------------------------ */
/* 1 — the beam (all shells, one draw call)                            */
/* ------------------------------------------------------------------ */

export const coreBeamVertex = /* glsl */ `
attribute vec4 aShell;   // x flow rate · y gain · z striation amt · w hot core

varying vec3 vWorld;
varying vec3 vNormalView;
varying vec3 vViewPos;
varying float vFogDepth;
varying vec2 vUv;
varying vec4 vShell;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalView = normalize(normalMatrix * normal);
  vUv = uv;
  /* constant across each shell's vertices, so interpolation is exact */
  vShell = aShell;
  vec4 mvPosition = viewMatrix * world;
  vViewPos = mvPosition.xyz;
  vFogDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const coreBeamFragment = /* glsl */ `
uniform float uFlow;       // striation descent, world-units/second (master)
uniform float uGain;       // master brightness of the column body
uniform float uBandGain;   // the year band's push past the bloom threshold
uniform float uHasRays;    // 0 until light-rays.png actually arrives
uniform sampler2D uRays;   // the plate, or a white 1×1 placeholder

varying vec3 vWorld;
varying vec3 vNormalView;
varying vec3 vViewPos;
varying float vFogDepth;
varying vec2 vUv;
varying vec4 vShell;

${glslNoiseCommon}
${glslSnoise2}
${pillarShared}

void main() {
  vec3 N = normalize(vNormalView);
  vec3 V = normalize(-vViewPos);
  float facing = clamp(dot(N, V), 0.0, 1.0);

  /* THE FALLOFF. For a cylinder of glow the chord a view ray cuts through
     the volume is ∝ facing, so facing² is the soft physical lobe: 1 on
     the sightline through the axis, EXACTLY 0 at the silhouette — the
     column has no edge, only air that stops glowing. facing⁷ is the hot
     filament living on the axis line itself. */
  float lobe = facing * facing;
  float hot = pow(facing, 7.0);

  float y = vWorld.y;

  /* Striation phase: a feature sits at constant (y + t·flow), so it
     descends at exactly flow world-units/second. Each shell runs its own
     multiplier (vShell.x) — the parallax between them is what makes two
     nested gradients read as one volume. */
  float flowP = y + uTime * uFlow * vShell.x;

  /* The ray plate, crossfaded between two copies half a period apart
     (triangle weights, w1 + w2 ≡ 1) so a non-tiling texture scrolls
     forever without a pop; v stays inside [0.14, 0.88], clear of the
     plate's source blob and empty tail. u wraps under REPEAT at an
     integer ×2 of the cylinder's own uv — seamless around. */
  float p = flowP * 0.030;
  float p1 = fract(p);
  float p2 = fract(p + 0.5);
  float w1 = 1.0 - abs(2.0 * p1 - 1.0);
  float u1 = vUv.x * 2.0 + uTime * 0.004;
  float texStri = texture2D(uRays, vec2(u1, 0.14 + 0.74 * p1)).r * w1
                + texture2D(uRays, vec2(u1 + 0.37, 0.14 + 0.74 * p2)).r
                  * (1.0 - w1);
  texStri *= 2.6;                      // plate mean ≈ 0.33 → ≈ 1.0

  /* Procedural fallback: streaks elongated in y (angular frequency high,
     vertical low), fed the unit circle so they close around the shell. */
  vec2 ring = vWorld.xz / max(length(vWorld.xz), 1e-4);
  float pn = flowP * 0.055;
  float n1 = snoise2(ring * 2.6 + vec2(0.3 * pn, pn));
  float n2 = snoise2(ring * 5.2 + vec2(-0.7 * pn, 1.7 * pn + 9.0));
  float procStri = 0.85 + 0.42 * n1 + 0.20 * n2;

  float stri = mix(procStri, texStri, uHasRays);
  float striae = mix(1.0, max(stri, 0.0), vShell.z);

  /* The body: near-white gold on the axis breathing to amber at the
     feathered edges — colour says depth even where intensity is subtle. */
  float body = (lobe * 0.6 + hot * vShell.w) * striae * uGain * vShell.y;
  vec3 col = mix(C_AMBER, C_GOLD, 0.30 + 0.70 * facing) * body;

  /* The year band: era-coloured light living INSIDE the column — it is
     multiplied by the same lobe, so it has no edge either, and on the
     faint outer sleeve it seeds the era halo in the surrounding air. */
  col += bandColorAt(y) * (bandAt(y) * uBandGain * vShell.y) * lobe;

  /* breath; endless ends (alpha → 0 over the top/bottom 15% — a light
     column has no ends); recede-without-greying */
  col *= breath();
  col *= 1.0 - smoothstep(END_FADE_IN, HALF_H, abs(y));
  col *= depthFade(vFogDepth);

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* 2 — the dust                                                        */
/* ------------------------------------------------------------------ */

/* Everything but the sprite's own shape is computed per-mote here in the
   vertex stage — for gl_Points the varyings are constant across the
   sprite anyway, so the fragment program stays two fetches wide. */
export const coreDustVertex = /* glsl */ `
uniform float uPixelRatio;

attribute vec4 aSeed;

varying vec3 vColor;

${pillarShared}

void main() {
  vec3 p = position;

  /* Descent + wrap: motes fall VERY slowly and re-enter from the top;
     mod() keeps them inside the column and the end fade below hides the
     re-entry. All of it is seed + uTime — the CPU never touches a mote,
     and a reduced-motion visit simply holds this frame's arrangement. */
  float fall = uTime * (0.045 + 0.075 * aSeed.w);
  p.y = mod(p.y - fall + DUST_HALF_H, DUST_H) - DUST_HALF_H;

  /* slow lateral wander, per-mote phase and rate — drift, not orbit */
  float wob = uTime * (0.05 + 0.11 * aSeed.x) + aSeed.y * 6.2831853;
  p.x += sin(wob) * 0.16;
  p.z += cos(wob * 0.83 + aSeed.z * 6.2831853) * 0.16;

  /* brightest where the beam is brightest: the same axial falloff the
     shells carry, so the dust reads as air the light is standing in */
  float beamW = exp(-dot(p.xz, p.xz) * 2.2);

  /* a slow individual shimmer (frozen with uTime under reduced motion) */
  float tw = 0.55 + 0.45 * sin(uTime * (0.3 + 0.9 * aSeed.z)
                               + aSeed.w * 6.2831853);

  /* motes IGNITE as the year band sweeps through them — the scanner line
     made physical */
  float ignite = bandAt(p.y);

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

  float endFade = 1.0 - smoothstep(DUST_FADE_IN, DUST_HALF_H, abs(p.y));
  float glow = (0.30 + 0.70 * tw) * beamW * endFade * (1.0 + 2.5 * ignite);

  vec3 tint = mix(mix(C_AMBER, C_GOLD, 0.72), bandColorAt(p.y),
                  min(ignite, 1.0) * 0.65);
  vColor = tint * glow * DUST_GAIN * breath() * depthFade(-mvPosition.z);

  gl_PointSize = clamp((1.1 + 2.1 * aSeed.x) * uPixelRatio
                       * (24.0 / -mvPosition.z),
                       1.0, 9.0 * uPixelRatio);
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const coreDustFragment = /* glsl */ `
uniform sampler2D uSprite;   // spark-point.png, or a white 1×1 placeholder
uniform float uHasSprite;    // 0 until (and unless) the plate actually loads

varying vec3 vColor;

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  if (d2 > 1.0) discard;

  /* soft gaussian falloff, guaranteed zero at the rim — the same curve
     the delivered sprite carries, drawn by hand when it is absent */
  float fall = exp(-d2 * 4.0) * (1.0 - d2 * d2);
  float shape = mix(fall, texture2D(uSprite, gl_PointCoord).r, uHasSprite);

  gl_FragColor = vec4(vColor * shape, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
