/* intro.glsl.js — every shader the opening sequence draws with, plus THE
   CURVE itself (the one thing both languages need to agree about).

   Composition rules are chunks.glsl.js's: glslNoiseCommon precedes the
   simplex noises, nothing re-declares precision (three's ShaderMaterial
   prefix already did), and each program includes glslIntroPalette / glslEcg
   at most once.

   ── THE CURVE, WRITTEN ONCE ──────────────────────────────────────────
   The heartbeat is an ECG evaluated ANALYTICALLY — piecewise smoothsteps,
   no lookup texture, no CPU path to sample. But TWO consumers need it: the
   GPU (particles spring onto it; the dust plate lights the air around it)
   and the CPU (the travelling lamp has to be placed at the head of the
   line, in JS, every frame). So the wave table below is the single source
   of truth and the GLSL function is GENERATED from it — the two can never
   drift, because there is only one of them.

   ── WHAT THE COLOUR VALUES MEAN (read before tuning anything) ────────
   Every fragment here writes LINEAR HDR into the composer's half-float
   buffer and multiplies by uComp — the intro's exposure compensation.
   js/post.js applies the era ledger's exposure ONCE, at the end of the
   chain, inside FilmGrade's ACES; js/intro.js sets uComp = 1/exposure, so

       final = ACES(exposure · authored · (1/exposure)) = ACES(authored)

   i.e. authored values are what you see, independent of how dark the world
   behind the intro is being held. Authored ~0.7 starts to bloom (the
   threshold is on the buffer, pre-exposure, so during the dark hold the
   trail blooms generously — that is the "light trails over a void" look and
   it relaxes to normal as the exposure ramp brings uComp back to 1).
   Authored ~4.5 saturates ACES to near-white: that is the whiteout.

   Additive OVERDRAW does most of the work on the particles — a pixel of the
   drawn line collects tens of sprites — which is why BASE_GAIN in intro.js
   is a small number and why the knot DIMS per-particle as it compresses
   (same light, smaller area) instead of brightening. */

import { glslNoiseCommon, glslSnoise3, glslHash } from './chunks.glsl.js';

/* ------------------------------------------------------------------ */
/* THE CURVE — one table, two languages                                */
/* ------------------------------------------------------------------ */

/* y(x) for x ∈ [0,1] in units where the R strike is 1.0:
   flat baseline · P bump · Q dip · R spike · S dip · T bump · flat tail.
   Split rise/fall widths are what make the R strike asymmetric and sharp. */
const ECG_WAVES = [
  { a: 0.150, c: 0.300, wr: 0.075, wf: 0.075 },   // P
  { a: -0.140, c: 0.418, wr: 0.022, wf: 0.022 },  // Q
  { a: 1.000, c: 0.452, wr: 0.016, wf: 0.024 },   // R — the strike
  { a: -0.340, c: 0.500, wr: 0.028, wf: 0.028 },  // S
  { a: 0.300, c: 0.650, wr: 0.095, wf: 0.095 },   // T
];

function smoothstepJS(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* The CPU's copy — used only to place the travelling lamp at the head of
   the line. Identical by construction to the GLSL below. */
export function ecgY(x) {
  let y = 0;
  for (let i = 0; i < ECG_WAVES.length; i += 1) {
    const w = ECG_WAVES[i];
    y += w.a * smoothstepJS(w.c - w.wr, w.c, x)
       * (1 - smoothstepJS(w.c, w.c + w.wf, x));
  }
  return y;
}

/* GLSL needs an explicit decimal point, and a leading unary minus after a
   `+` is legal but ugly — parenthesise negatives. */
function lit(n) {
  return n < 0 ? '(' + n.toFixed(4) + ')' : n.toFixed(4);
}

const ecgTerms = ECG_WAVES
  .map((w) => `${lit(w.a)} * wave2(x, ${lit(w.c)}, ${lit(w.wr)}, ${lit(w.wf)})`)
  .join('\n       + ');

export const glslEcg = /* glsl */ `
float wave2(float x, float c, float wr, float wf) {
  return smoothstep(c - wr, c, x) * (1.0 - smoothstep(c, c + wf, x));
}
float ecgY(float x) {
  return ${ecgTerms};
}
`;

/* ------------------------------------------------------------------ */
/* shared fragments                                                    */
/* ------------------------------------------------------------------ */

/* The two lamplight colours the whole site is lit by, in LINEAR sRGB —
   the same pair js/thread.js and js/post.js's streak tint use. */
export const glslIntroPalette = /* glsl */ `
const vec3 GOLD  = vec3(1.0, 0.8148, 0.6276);  // #FFE9C4 firefly gold
const vec3 AMBER = vec3(1.0, 0.4793, 0.1301);  // #FFB865 lamplight amber
`;

/* Curl of a scalar noise field in the xy plane: divergence-free, so the
   trail gains thickness and swirl without the particles clumping. */
const glslCurl = /* glsl */ `
vec2 curl2(vec3 p) {
  const float e = 0.35;
  float n1 = snoise3(p + vec3(0.0, e, 0.0));
  float n2 = snoise3(p - vec3(0.0, e, 0.0));
  float n3 = snoise3(p + vec3(e, 0.0, 0.0));
  float n4 = snoise3(p - vec3(e, 0.0, 0.0));
  return vec2(n1 - n2, n4 - n3) * (0.5 / e);
}
`;

/* Every camera-parented plate shares this vertex stage: a unit
   PlaneGeometry, scaled by the CPU to whatever the live lens needs. */
export const introPlateVertex = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* compute shaders (GPUComputationRenderer)                            */
/* ------------------------------------------------------------------ */

/* GPUComputationRenderer prepends `uniform sampler2D texturePosition;` and
   `uniform sampler2D textureVelocity;` and #defines `resolution`. */

export const introPositionShader = /* glsl */ `
uniform float uDelta;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posSeed = texture2D(texturePosition, uv);
  vec3 vel = texture2D(textureVelocity, uv).xyz;
  /* .w is the particle's immutable seed — carried, never integrated. */
  gl_FragColor = vec4(posSeed.xyz + vel * min(uDelta, 0.033), posSeed.w);
}
`;

/* Four floats a frame reach this shader (uDelta, uPhase, uPhaseT, uHead)
   plus the lens pair; every behaviour lives here, selected by a UNIFORM
   branch — coherent across the whole draw, and no dynamic loops anywhere. */
export const introVelocityShader = /* glsl */ `
uniform float uDelta;
uniform float uPhase;
uniform float uPhaseT;
uniform float uHead;
uniform float uSpan;
uniform float uAmp;
uniform float uTime;

${glslNoiseCommon}
${glslSnoise3}
${glslHash}
${glslEcg}
${glslCurl}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posSeed = texture2D(texturePosition, uv);
  vec3 pos = posSeed.xyz;
  vec3 vel = texture2D(textureVelocity, uv).xyz;
  float seed = posSeed.w;
  float dt = min(uDelta, 0.033);

  /* Every particle owns a slot along the curve: uv.x IS its x parameter,
     nudged by its seed so the 128/256 texture columns never read as bands. */
  float u = clamp(uv.x + (seed - 0.5) * (1.7 / resolution.x), 0.0, 1.0);

  if (uPhase < 0.5) {
    /* ---- DRAW: spring onto the ECG, revealed left → right --------------
       Particles the front has not reached yet all target the FRONT itself,
       so the leading edge is a dense, fast, bright head that sheds settled
       particles behind it — the line draws itself, written by one light. */
    float mine = min(u, uHead);
    vec2 tgt = vec2((mine - 0.5) * 2.0 * uSpan, ecgY(mine) * uAmp);
    float thick = 0.05 + 0.09 * hash12(uv * 37.1);
    tgt += curl2(vec3(mine * 5.5, seed * 12.0, uTime * 0.5)) * uAmp * thick;
    /* A little depth as well as thickness: the trace is a filament in air,
       not a decal on glass, so the sprite sizes vary with true distance. */
    float tz = curl2(vec3(seed * 9.0, mine * 4.0, uTime * 0.37)).x
             * uAmp * thick * 0.7;
    vel += (vec3(tgt, tz) - pos) * (46.0 * dt);
    vel *= exp(-7.0 * dt);
  } else if (uPhase < 1.5) {
    /* ---- GATHER: the curve target SPINS as it shrinks ------------------
       Rotating the target while collapsing it is what buys a visible
       swirl: every particle rides an arc into the middle instead of being
       sucked down a straight line. A tangential impulse on top adds the
       angular momentum, and the last quarter trembles. */
    float k = smoothstep(0.0, 1.0, uPhaseT);
    vec2 curveP = vec2((u - 0.5) * 2.0 * uSpan, ecgY(u) * uAmp);
    float turn = k * 3.4;                       // radians by the end
    float cs = cos(turn);
    float sn = sin(turn);
    vec2 spun = vec2(curveP.x * cs - curveP.y * sn,
                     curveP.x * sn + curveP.y * cs);
    float shrink = (1.0 - k) * (1.0 - k);
    vec3 target = vec3(spun * shrink, 0.0);

    float rl = max(length(pos.xy), 0.001);
    vec2 tang = vec2(-pos.y, pos.x) / rl;
    vel.xy += tang * (2.8 + 5.4 * seed) * (0.3 + k) * dt;
    vel.z += (hash12(uv * 5.7) - 0.5) * 2.2 * dt;      // give the knot depth
    vel += (target - pos) * ((24.0 + 66.0 * k) * dt);

    /* the held breath: ~250ms of trembling at peak compression */
    float trem = smoothstep(0.74, 1.0, uPhaseT);
    vel.xy += vec2(hash12(uv * 3.3 + uTime * 1.7) - 0.5,
                   hash12(uv * 7.7 + uTime * 2.3) - 0.5) * (trem * 30.0 * dt);
    vel *= exp(-4.8 * dt);
  } else if (uPhase < 2.5) {
    /* ---- BURST: no springs. A front-loaded impulse along a hashed
       direction (biased outward from the knot), an updraft, and drag. ---- */
    vec3 rnd = vec3(hash12(uv * 13.7), hash12(uv * 29.3), hash12(uv * 47.1)) - 0.5;
    vec3 dir = normalize(rnd + vec3(1e-4, 0.0, 0.0));
    float rl = length(pos.xy);
    vec3 radial = vec3(pos.xy / max(rl, 0.001), dir.z * 0.35);
    dir = normalize(mix(dir, radial, 0.42) + vec3(1e-4, 0.0, 0.0));
    float kick = exp(-uPhaseT * 9.0);
    float speed = 2.8 + 12.0 * seed * seed;
    vel += dir * (speed * kick * 9.5 * dt);
    vel.y += 2.4 * dt;                    // everything drifts up as it dies
    vel *= pow(0.98, dt * 60.0);          // 0.98/frame at 60Hz, dt-correct
  } else {
    /* ---- DONE: freeze. ------------------------------------------------ */
    vel *= pow(0.90, dt * 60.0);
  }

  gl_FragColor = vec4(vel, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* the trail                                                           */
/* ------------------------------------------------------------------ */

/* `position` carries the particle's texture reference in xy — there is no
   CPU-side position to store, so the buffer earns its bytes twice. */
export const introPointVertex = /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uPixelRatio;
uniform float uFade;
uniform float uPhase;
uniform float uPhaseT;
uniform float uHead;
uniform float uSizeGain;

varying float vI;

void main() {
  vec2 ref = position.xy;
  vec4 posSeed = texture2D(uPos, ref);
  float speed = length(texture2D(uVel, ref).xyz);

  /* Uniform-driven masks, not branches — one program, three readings. */
  float isDraw = 1.0 - step(0.5, uPhase);
  float isKnot = step(0.5, uPhase) * (1.0 - step(1.5, uPhase));
  float isPost = step(1.5, uPhase);

  /* DRAW — the comet. A particle is dark until the front reaches ITS slot;
     right at the front it is overbright (the hot head), just behind it a
     fast-decaying comet tail, and behind THAT a floor: the written line,
     which has to stay legible until the gather takes it. */
  float d = uHead - ref.x;
  float written = smoothstep(-0.006, 0.02, d);
  float comet = exp(-max(d, 0.0) * 15.0);
  float glow = exp(-max(d, 0.0) * 2.3);
  float drawB = written * (0.22 + 0.75 * glow + 2.6 * comet);

  /* GATHER — per-particle brightness FALLS as the knot compresses: the
     same light in a smaller area is already a brightening, and letting the
     sprite gain ride along would blow the knot out before the detonation
     (the whole point of the held breath is that it is still under). */
  float trem = smoothstep(0.74, 1.0, uPhaseT);
  float knotB = mix(0.95, 0.42, uPhaseT) * (1.0 + 0.30 * trem);

  /* BURST/DONE — the reading inverts: speed means burning out. */
  float postB = 1.0 / (1.0 + speed * 0.22);

  float bright = isDraw * drawB + isKnot * knotB + isPost * postB;
  vI = bright * uFade * (0.45 + 0.55 * fract(posSeed.w * 7.3));

  vec4 mv = modelViewMatrix * vec4(posSeed.xyz, 1.0);
  /* the head is a pile of not-yet-released particles: let them read bigger
     as well as hotter, so the writing light has a physical size */
  float grow = 1.0 + 1.5 * comet * isDraw;
  gl_PointSize = clamp(
    (2.4 + 3.6 * fract(posSeed.w * 3.1)) * uPixelRatio * uSizeGain * grow
      * (10.0 / -mv.z),
    1.0, 26.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
}
`;

export const introPointFragment = /* glsl */ `
uniform sampler2D uSprite;
uniform float uWarm;
uniform float uGain;

varying float vI;

${glslIntroPalette}

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  if (d2 > 1.0) discard;

  /* The photographic point sprite (assets/textures/spark-point.png, a
     procedural gaussian until it lands) times a rim kill, so the sprite is
     guaranteed to reach exactly zero at the quad edge whatever the plate
     does — no square ghosts, ever. */
  float fall = texture2D(uSprite, gl_PointCoord).r * (1.0 - d2 * d2);

  /* Real light clips to white in the core and keeps its colour in the
     halo: the brighter the particle, the whiter its middle. */
  vec3 tint = mix(GOLD, AMBER, uWarm);
  vec3 col = mix(tint, vec3(1.0), clamp(vI * 0.32, 0.0, 0.85))
           * (fall * vI * uGain);
  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* the travelling lamp — the light that writes the line                */
/* ------------------------------------------------------------------ */

export const introLampFragment = /* glsl */ `
uniform sampler2D uSprite;
uniform float uGain;
uniform float uWarm;
uniform float uComp;

varying vec2 vUv;

${glslIntroPalette}

void main() {
  vec2 pc = vUv * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  float s = texture2D(uSprite, vUv).r * (1.0 - smoothstep(0.55, 1.0, d2));
  /* white-hot filament, amber air around it */
  vec3 tint = mix(vec3(1.0), mix(GOLD, AMBER, uWarm), smoothstep(0.01, 0.42, d2));
  gl_FragColor = vec4(tint * (s * uGain * uComp), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* the dust plate — air, made visible by the light passing through it  */
/* ------------------------------------------------------------------ */

/* One camera-parented plate behind the trace. It re-evaluates THE CURVE
   per fragment and lights motes near it, gated by the same head parameter
   the particles use — so the dust does not glow before the light arrives.
   Two scrolling taps of one mote plate give parallax for one draw call. */
export const introDustFragment = /* glsl */ `
uniform sampler2D uDust;
uniform float uGain;
uniform float uHead;
uniform float uSpan;
uniform float uAmp;
uniform float uTime;
uniform float uComp;
uniform vec2 uExtent;

varying vec2 vUv;

${glslIntroPalette}
${glslEcg}

void main() {
  vec2 p = (vUv - 0.5) * 2.0 * uExtent;              // world units, trace plane
  float x = clamp(p.x / (2.0 * uSpan) + 0.5, 0.0, 1.0);
  float dy = p.y - ecgY(x) * uAmp;
  float k = 1.6 / max(uAmp * uAmp, 0.01);            // falls off over ~1 amp
  float near = exp(-dy * dy * k);
  float lit = near * smoothstep(-0.03, 0.05, uHead - x);

  float m = texture2D(uDust, vUv * 1.7 + vec2(uTime * 0.006, uTime * -0.004)).r
          + texture2D(uDust, vUv * 3.1 + vec2(uTime * -0.011, uTime * 0.008)).r * 0.6;

  /* the plate never shows its own rectangle */
  vec2 e = smoothstep(0.0, 0.18, vUv) * (1.0 - smoothstep(0.82, 1.0, vUv));

  gl_FragColor = vec4(GOLD * (m * lit * uGain * uComp * e.x * e.y), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* the ink detonation                                                  */
/* ------------------------------------------------------------------ */

/* Per-quad UV rotation/zoom/drift happens in the vertex stage so the same
   plate — one ink-bloom video frame, or one plume photograph — can be
   sampled three ways and never read as three copies of itself. */
/* uZoom is a vec2 for one reason: the still plates are square and the video
   is 16:9, so the y sample range is divided by the clip's aspect when the
   video is the one that made it — the same crop, undistorted, either way. */
export const introInkVertex = /* glsl */ `
uniform float uRot;
uniform vec2 uZoom;
uniform vec2 uDrift;

varying vec2 vUv;
varying vec2 vQuad;

void main() {
  vQuad = uv;
  vec2 c = uv - 0.5;
  float cs = cos(uRot);
  float sn = sin(uRot);
  vUv = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * uZoom + 0.5 + uDrift;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const introInkFragment = /* glsl */ `
uniform sampler2D uMap;
uniform float uAmount;
uniform float uWarm;
uniform float uCore;
uniform float uComp;

varying vec2 vUv;
varying vec2 vQuad;

${glslIntroPalette}

void main() {
  vec3 t = texture2D(uMap, vUv).rgb;
  float d = max(t.r, max(t.g, t.b));   // white-on-black plate, or video luma

  /* TWO rim guards, both smooth. vQuad kills the quad's own edge — the
     detonation grows past it and must never show a straight line. vUv kills
     the PLATE's edge, which matters because ink-plume-b has a filament
     running into its bottom-left corner and the video reaches all four
     sides by the end of its arc; clamped sampling would smear either. */
  vec2 q = smoothstep(0.0, 0.10, vQuad) * (1.0 - smoothstep(0.90, 1.0, vQuad));
  vec2 s = smoothstep(0.0, 0.04, vUv) * (1.0 - smoothstep(0.96, 1.0, vUv));
  float v = d * q.x * q.y * s.x * s.y * uAmount;

  /* the densest ink burns white, the fringe stays gold→amber */
  vec3 tint = mix(mix(GOLD, AMBER, uWarm), vec3(1.0), clamp(d * uCore, 0.0, 0.9));
  gl_FragColor = vec4(tint * (v * uComp), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* the whiteout — the cut-hider                                        */
/* ------------------------------------------------------------------ */

/* Authored ~5 saturates ACES to white AND floods the bloom threshold, so
   the frame blows out completely for ~180ms. Underneath it the world's
   exposure runs 4% → 100%; when the white falls away the spiral is simply
   there. Warm, not clinical, and hotter in the middle than at the corners
   so the falloff reads like light rather than a rectangle of paint. */
export const introFlashFragment = /* glsl */ `
uniform float uWhite;
uniform float uComp;

varying vec2 vUv;

void main() {
  vec2 c = vUv - 0.5;
  float r2 = clamp(dot(c, c) * 2.0, 0.0, 1.0);
  float shape = 1.0 - 0.42 * r2 * r2;
  gl_FragColor = vec4(vec3(1.0, 0.972, 0.930) * (uWhite * uComp * shape), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* the pillar — the seed in the void, and the column it opens into     */
/* ------------------------------------------------------------------ */

/* ONE world-static object does two jobs a beat apart, because they are the
   same object in the story: the single point of light the void opens on IS
   the pillar's seed, and the detonation is it finally opening. A quad on
   the axis, yawed to face the camera; light travels out from y = 0 at
   ~90 units/second (uReach), a hot cap riding the front. */
export const introPillarFragment = /* glsl */ `
uniform float uReach;
uniform float uFlash;
uniform float uSeed;
uniform float uComp;
uniform float uTime;
uniform vec2 uSize;

varying vec2 vUv;

${glslIntroPalette}

void main() {
  float x = (vUv.x - 0.5) * 2.0 * uSize.x;
  float y = (vUv.y - 0.5) * 2.0 * uSize.y;
  float ay = abs(y);
  float reach = max(uReach, 0.02);

  float core = exp(-x * x * 2.4);        // the hot axis line
  float body = exp(-x * x * 0.32);       // the column around it
  float inside = 1.0 - smoothstep(reach * 0.86, reach, ay);
  float ahead = ay - reach;
  float front = exp(-ahead * ahead * 1.1);
  float dim = 0.30 + 0.70 * exp(-ay * 0.045);
  float column = inside * dim * (core * 0.9 + body * 0.22) + front * core * 1.6;

  float seed = exp(-(x * x + y * y) * 5.5) * uSeed;
  float flick = 0.93 + 0.07 * sin(uTime * 2.3);

  vec3 c = mix(GOLD, vec3(1.0), 0.55) * (column * uFlash * flick)
         + vec3(1.0, 0.95, 0.88) * seed;
  gl_FragColor = vec4(c * uComp, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
