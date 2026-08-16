/* mistfield.glsl.js — GLSL for THE INK FIELD (js/mistfield.js): the A/B
   alternative to the GPGPU spine mist. Two sources, one program, five
   draw calls total.

   ── THE TECHNIQUE (what the reference site actually does) ────────────
   The substance NEVER animates. A modest number of large, photographic,
   static ink plumes hang in 3D as cylindrical billboards, and every bit
   of perceived motion is the WORLD turning: the field is parented inside
   spiralGroup, so the scroll's rotation and rise sweep solid, coherent
   cloud shapes past the camera with real parallax. High quality comes
   from texture resolution, not particle count — one 1024² plume beats
   sixteen thousand sprites at reading as INK.

   ── THE CONTRACT ─────────────────────────────────────────────────────
   Instanced attributes (one quad, N instances, via InstancedBufferGeometry):
     iPos    vec3   anchor, spiralGroup-local. NEVER moves after build.
     iScale  vec2   quad width/height in world units (x may be NEGATIVE:
                    a build-time mirror so one texture reads as many clouds)
     iSeed   vec4   x phase (rad) · y breath freq (rad/s) · z roll amplitude
                    (rad, 0 on half the field) · w roll freq (rad/s)
     iMisc   vec4   x shear gain (0 on far billboards) · y glow variance ·
                    z hue jitter (−1..1) · w body variance
   Uniforms (shared BY REFERENCE across all five materials — one write per
   frame reaches the whole field):
     uTime uIntensity uPulse uFocusY uSpin uEraColors[6] uVoid
   Per-material: uMap (that species' texture). Define: HELIX_H (from
   spiral.js HEIGHT via mistfield.js — the curve is never hardcoded here).

   ── CYLINDRICAL BILLBOARDING ─────────────────────────────────────────
   Y-axis only, in the vertex shader: the quad's right vector is built in
   WORLD space from the instance anchor and three's built-in cameraPosition
   uniform, with the up vector pinned to world +Y. spiralGroup only ever
   rotates about Y and translates along Y, so group-local vertical IS world
   vertical — a plume's column stays a column under camera tilt, and the
   face turns to meet the camera only about the axis. Full spherical
   billboarding would lay the plumes back as the ledger pitches the camera
   down, which is exactly the cardboard tell this system exists to avoid.

   ── THE TWO-LAYER COLOUR MODEL (one fragment, one pass) ──────────────
   Blending is premultiplied: One / OneMinusSrcAlpha. The fragment emits
     rgb = bodyCol·bodyA + glowCol      a = bodyA
   so a single draw both OCCLUDES and EMITS:
     BODY — a dim mass pulled toward the void colour, alpha rising with
     texture density. This is WEIGHT: the cloud darkens the stars behind
     it, which additive mist can never do and is why additive-only fields
     read as grain. Purely additive at a=0, purely solid at a=1.
     GLOW — a luminance-preserving era tint, added on top: mids take the
     colour of the era at the billboard's height, bright cores stay
     near-white (ink lit from within). Kept modest — the U6 bloom
     (threshold 0.72) does the lift, catching only breathing peaks and
     pulsed cores rather than the whole field.

   ── OVERDRAW, REASONED ───────────────────────────────────────────────
   Screen height in world units ≈ 0.83·depth at fov ≈ 46°, so a billboard
   of size s at depth d rasterises ≈ (s/(0.83d))² of the screen. Summed
   over the shipped layout (outer field mostly at depth 20–55, sizes 5–16;
   near wisps 3–5 at 14–35) that is ~2.5–3.5 full screens RASTERISED —
   and because the golden-angle layout turns rigidly with the group, that
   figure is invariant over the whole scroll. The textures are floor-
   crushed to true 0 over 55–90% of their area, and the fragment discards
   below DISCARD_AT after its single fetch, so the BLENDED fill is ~1.0–1.5
   screens of a one-fetch + ~20-op shader — roughly a quarter of the ~5–6×
   one-fetch overdraw the GPGPU mist budgets for the same slot. The other
   backstop is in the vertex stage: a billboard whose depth fades put it
   below visibility collapses its quad to zero area and never rasterises
   (outer plumes sweep behind the camera once per revolution; this is what
   keeps that pass free).

   Precision: three's ShaderMaterial prefix declares `precision highp
   float;` for every stage; nothing here re-declares it. ES 1.00 style
   (attribute/varying/texture2D), same as every shader in this repo. */

import { glslLuma } from './chunks.glsl.js';

/* ------------------------------------------------------------------ */
/* vertex: billboard frame, permitted life, era colour                 */
/* ------------------------------------------------------------------ */

export const mistFieldVertex = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iScale;
attribute vec4 iSeed;
attribute vec4 iMisc;

uniform float uTime;
uniform float uIntensity;   // eased 0..1 — the app's density dial
uniform float uPulse;       // decaying 0..1.5 — era-boundary surge
uniform float uFocusY;      // group-local y of the current progress
uniform float uSpin;        // world rig angular velocity, rad/s (smoothed)
uniform vec3 uEraColors[6];

varying vec2 vUv;      // sample coordinate (rolled + sheared)
varying vec2 vQuad;    // undeformed quad coordinate, for the edge mask
varying vec3 vTint;
varying float vGlow;
varying float vBody;

${glslLuma}

/* ---- permitted life (barely perceptible; the substance is static) --- */
const float BREATH_AMP  = 0.06;   // ±6% opacity breathing
const float SHEAR_MAX   = 0.04;   // velocity → vertical UV shear, hard cap
/* Roll is a bounded SWAY, not an integration: angle = amp·sin(ωt+φ) with
   amp ≤ 0.035 rad and amp·ω ≤ 0.02 rad/s (the spec's rate cap). An
   integrated roll would slowly lay plumes on their sides; a sway cannot. */

/* ---- pulse: the arrangement never moves, billboards near the focus
        height briefly swell and brighten ------------------------------ */
const float PULSE_RANGE  = 3.0;   // ± world units around uFocusY
const float PULSE_SCALE  = 0.35;  // +35% scale at strength 1
const float PULSE_BRIGHT = 0.50;  // +50% brightness at strength 1

/* ---- depth manners --------------------------------------------------
   NEAR: outer billboards (r up to 34 > camera orbit ~26) sweep past and
   behind the lens once per revolution; they must be gone before the near
   plane carves a hard edge across a 16-unit quad. FAR: melt toward the
   fog instead of stacking a bright wall at the back. Below ALIVE_AT the
   quad collapses to zero area in this stage and never rasterises. */
const float NEAR_LO  = 2.5;
const float NEAR_HI  = 7.5;
const float FAR_LO   = 42.0;
const float FAR_HI   = 82.0;
const float FAR_CUT  = 0.85;
const float ALIVE_AT = 0.004;

/* ---- the master dials (tune the look here) -------------------------- */
const float GLOW_GAIN = 0.55;  // luminous term; cores graze bloom at rest
const float BODY_GAIN = 0.62;  // weight term; peak occlusion ~0.6 alpha
const float HUE_JIT   = 0.07;  // era-coordinate jitter — neighbour leakage
const float SAT       = 1.12;  // gentle push past the source tint

/* The era of a HEIGHT, as a tent-basis blend of the six tints — constant
   indices only (dynamic uniform-array indexing is not guaranteed in ES
   1.00). Same coordinate convention as js/eras.js: era i at t = i/5. */
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

void main() {
  vQuad = uv;

  /* ---- cylindrical billboard frame, world space --------------------- */
  vec3 anchorW = (modelMatrix * vec4(iPos, 1.0)).xyz;
  vec2 f = cameraPosition.xz - anchorW.xz;
  f /= max(length(f), 1e-4);
  /* up × forward for up = +Y: the quad's right vector, always horizontal */
  vec3 right = vec3(f.y, 0.0, -f.x);

  /* ---- pulse: proximity of this billboard to the focus height ------- */
  float nearP = 1.0 - smoothstep(0.0, PULSE_RANGE, abs(iPos.y - uFocusY));
  float pk = uPulse * nearP;
  float scale = 1.0 + PULSE_SCALE * pk;

  /* ---- depth fades, taken at the ANCHOR so the whole quad fades as one
     (per-corner fades would warp brightness across a big billboard) ---- */
  vec4 av = viewMatrix * vec4(anchorW, 1.0);
  float depth = -av.z;
  float fade = smoothstep(NEAR_LO, NEAR_HI, depth)
             * (1.0 - smoothstep(FAR_LO, FAR_HI, depth) * FAR_CUT);
  /* Dead billboards rasterise NOTHING: zero-area quad, zero fill. */
  float alive = step(ALIVE_AT, fade);

  vec3 world = anchorW
    + right * (position.x * iScale.x * scale * alive)
    + vec3(0.0, position.y * iScale.y * scale * alive, 0.0);
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));

  /* ---- permitted life on the SAMPLE coordinates ---------------------
     The quad's four uvs are rotated/sheared here; the interpolated result
     equals a per-pixel transform because the mapping is affine — the
     fragment pays nothing. Roll on half the field (iSeed.z = 0 on the
     rest); shear only where iMisc.x was built non-zero (near wisps),
     driven by the rig's own smoothed spin and hard-capped at ±SHEAR_MAX. */
  vec2 q = uv - 0.5;
  float ang = iSeed.z * sin(uTime * iSeed.w + iSeed.x);
  float ca = cos(ang);
  float sa = sin(ang);
  q = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);
  q.y += q.x * clamp(uSpin * iMisc.x, -SHEAR_MAX, SHEAR_MAX);
  vUv = q + 0.5;

  /* ---- era colour of the billboard's HEIGHT -------------------------
     t along the life from the local y (helix: y = −t·HELIX_H). The jitter
     shifts the LOOKUP coordinate, so variation comes as neighbour-era
     leakage — always inside the palette, never off it. */
  float t = clamp(-iPos.y / HELIX_H, 0.0, 1.0);
  vec3 tint = eraColorAt(t + iMisc.z * HUE_JIT);
  vTint = max(mix(vec3(luma(tint)), tint, SAT), 0.0);

  /* ---- amplitude chains ---------------------------------------------
     Breathing is the ONLY intrinsic life: ±6% over a 20–40s period,
     phase-hashed per billboard at build. uIntensity eases 0..1; glow
     follows it steeper than body so a staged photograph (0.15) keeps a
     ghost of substance while the light gets out of the way. */
  float breath = 1.0 + BREATH_AMP * sin(uTime * iSeed.y + iSeed.x * 1.7);
  float glowI = pow(max(uIntensity, 0.0), 1.4);
  vGlow = GLOW_GAIN * iMisc.y * breath * glowI
        * (1.0 + PULSE_BRIGHT * pk) * fade;
  vBody = BODY_GAIN * iMisc.w * breath
        * (0.25 + 0.75 * uIntensity) * fade;
}
`;

/* ------------------------------------------------------------------ */
/* fragment: one fetch, two layers, one pass                           */
/* ------------------------------------------------------------------ */

export const mistFieldFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uVoid;    // the ledger's live background — weight grounds here

varying vec2 vUv;
varying vec2 vQuad;
varying vec3 vTint;
varying float vGlow;
varying float vBody;

/* Edge falloff over the outer 5.5% of the quad. The delivered plumes run
   content to the borders (ink-plume-b has a filament touching the
   bottom-left corner; a and c ground their columns on the bottom edge) —
   without this, ClampToEdge would smear those texels into hard streaks at
   the rim. Computed on vQuad (the undeformed coordinate) so the mask holds
   still while the sample coordinate rolls. */
const float EDGE = 0.055;

/* Discard below ~1.2% contribution. The textures are floor-crushed to
   true 0, so this converts 55–90% of each quad's rasterised area into
   fetch-and-discard — no blend, no ROP — which is what caps the additive
   cost of 16-unit quads. Threshold chosen below any visible step: at 1.2%
   of an already-dim body the pop-in is under one 8-bit LSB after grade. */
const float DISCARD_AT = 0.012;

const float BODY_DENSITY = 2.2;   // coverage saturation: 1−e^(−m·D)
const float BODY_TINT    = 0.35;  // how far the mass leans from void → era
const float BODY_LUM     = 0.55;  // mass luminance vs the void: DARKER
const float CORE_LO      = 0.52;  // below: mids take the era colour…
const float CORE_HI      = 0.94;  // …above: cores stay near-white

void main() {
  float edge = smoothstep(0.0, EDGE, vQuad.x)
             * smoothstep(0.0, EDGE, 1.0 - vQuad.x)
             * smoothstep(0.0, EDGE, vQuad.y)
             * smoothstep(0.0, EDGE, 1.0 - vQuad.y);
  float m = texture2D(uMap, vUv).r * edge;

  /* One fetch, then out — everything below this line runs only on the
     55–90% of texels the plume photographs actually own. */
  if (m * max(vBody, vGlow) < DISCARD_AT) discard;

  /* BODY: saturating coverage from texture density. Premultiplied, so
     rgb carries bodyCol·alpha and the blend equation both occludes the
     background by that alpha and lays this dark mass in its place. */
  float body = (1.0 - exp(-m * BODY_DENSITY)) * vBody;
  vec3 bodyCol = mix(uVoid, vTint, BODY_TINT) * BODY_LUM;

  /* GLOW: luminance-preserving tint ramp keyed on the texture itself —
     density decides colour. Added OUTSIDE the alpha, so it survives the
     premultiplied blend as pure light. */
  float core = smoothstep(CORE_LO, CORE_HI, m);
  vec3 glow = mix(vTint * m, vec3(m), core) * vGlow;

  /* Tone mapping runs on the premultiplied sum; at these amplitudes the
     curvature error against post-blend mapping is far below visibility,
     and it keeps this pass on the same grade as every other shader. */
  gl_FragColor = vec4(bodyCol * body + glow, body);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
