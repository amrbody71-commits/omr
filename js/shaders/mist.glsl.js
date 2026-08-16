/* mist.glsl.js — GLSL for the SPINE MIST (js/mist.js): the volumetric ink
   that erupts off the Thread of Light and wraps the cards. Four sources:

     mistVelocityShader / mistPositionShader
       the GPGPU pair. Both are fragment shaders over the same size×size
       grid; GPUComputationRenderer prepends `uniform sampler2D
       texturePosition;` + `uniform sampler2D textureVelocity;` and #defines
       `resolution`.
     mistVertex / mistFragment
       the additive Points pass — ONE draw call for the whole field.

   ── THE COHERENCE RULE ───────────────────────────────────────────────
   compute() renders EVERY variable from the same previous-frame textures,
   so the two sim shaders see byte-identical inputs. A respawn is therefore
   DERIVED, never communicated: both shaders run the same arithmetic over
   the same (uv, uTime) and land on the same spawn point, the same birth
   height and the same impulse. No handshake texel, no ordering hazard.

   ── THE TEXEL BUDGET (2 RGBA texels per particle, nothing spare) ─────
     texturePosition   xyz = position, group-local    w = age, NORMALISED
     textureVelocity   xyz = velocity, units/s        w = birth height t
   Age is stored NORMALISED (0→1 over the particle's own lifespan) for one
   reason: the render pass then never has to re-derive a lifespan from a
   hash and risk disagreeing with the sim by one ULP. The render's own
   seeds are cosmetic — size, sprite cell, brightness — and are hashed
   freely because nothing in the sim ever reads them back.

   ── WHERE THE WORK HAPPENS ───────────────────────────────────────────
   A Points draw runs the vertex shader ONCE per particle and the fragment
   shader ~2 500 times (a 50 px sprite). So everything that is constant
   across a sprite — the era colour lookup, the saturation push, the whole
   amplitude chain — is computed in the VERTEX shader and handed over as
   flat varyings. The fragment shader is one texture fetch and ~15 ops,
   which is what makes 6× additive overdraw affordable.

   Geometry constants (SPINE_R / TURNS / HELIX_H) arrive as DEFINES from
   mist.js, which reads them from spiral.js and thread.js — this file never
   hardcodes the curve. Everything else here is art direction, gathered at
   the top of each stage so it can be tuned without reading the shader.

   Precision: three's ShaderMaterial prefix declares `precision highp
   float;` for every stage; nothing here re-declares it. */

import {
  glslNoiseCommon, glslSnoise3, glslHash, glslLuma,
} from './chunks.glsl.js';

/* ------------------------------------------------------------------ */
/* sim: shared helpers + the emission law                              */
/* ------------------------------------------------------------------ */

/* Everything BOTH sim shaders need. The respawn block is the important
   part: it is written once, included twice, and is a pure function of
   (uv, uTime, uProgress) — which is what makes the coherence rule hold. */
const glslMistSim = /* glsl */ `
#define TWO_PI 6.28318530718

/* ---- life ---------------------------------------------------------- */
const float LIFE_MIN   = 6.0;    // seconds; + LIFE_VAR·seed → a 6–9s life
const float LIFE_VAR   = 3.0;

/* ---- emission ------------------------------------------------------ */
const float LOCAL_BIAS = 0.74;   // share of births inside the travelling band
const float BAND_HALF  = 0.15;   // band half-width in t (±4.5 world units)
const float BIRTH_JIT  = 0.42;   // the spine is a filament, not a point
const float BIRTH_SPEED = 3.4;   // units/s — see the reach note below
const float INWARD_FRAC = 0.22;  // share that dives back across the axis
const float SURGE_AGE  = 2.3;    // pulse() ages the field → a wave of births
const float SURGE_KICK = 1.5;    // …and throws them harder

/* ---- advection ----------------------------------------------------- */
const float NOISE_SCALE = 0.15;  // world → noise space: ~6.6-unit billows
const float NOISE_DRIFT = 0.055; // the potential field itself evolves, slowly
const float CURL_GAIN  = 1.10;
const float LIFT       = 0.75;   // mist rises past a descending camera
const float DRAG       = 1.15;

/* REACH, so the numbers above are not magic. Drag is exponential with a
   time constant 1/DRAG = 0.87s, so an impulse v carries a particle v/DRAG
   before it stalls: 3.4/1.15 = 2.96 units. Births sit on the spine at
   SPINE_R = 11.4, so the opening puff lands at ~14.4 — the card ring is at
   14.0. The eruption reaches the photographs and wraps them, by
   construction. Curl then takes over at a terminal drift of about
   CURL_GAIN·|∇n|/DRAG ≈ 1.4 units/s, i.e. ~9 units over a full life. */

/* helixAt(t) from js/spiral.js, verbatim, pulled in to the thread radius:
   angle = t·TURNS·2π, y = −t·HELIX_H. The spiral DESCENDS, so y runs
   negative as t grows — mist born deeper is born lower. */
vec3 spineAt(float t) {
  float a = t * TURNS * TWO_PI;
  return vec3(sin(a) * SPINE_R, -t * HELIX_H, cos(a) * SPINE_R);
}

/* The axis the curl is taken about: world-up leaning toward the azimuthal
   tangent, so the ink shears ALONG the helix as it billows across it. */
vec3 swirlAxis(vec3 p) {
  float rl = max(length(p.xz), 0.001);
  vec3 tang = vec3(-p.z, 0.0, p.x) / rl;
  return normalize(mix(vec3(0.0, 1.0, 0.0), tang, 0.58));
}

/* Curl noise on ONE scalar potential: a 4-tap tetrahedral gradient (the
   entire noise budget — 4 snoise3 calls) crossed with a smooth axis field.

     div(∇N × A) = A·(∇×∇N) − ∇N·(∇×A) = −∇N·(∇×A)

   For a CONSTANT A that is exactly zero — genuinely divergence-free, which
   is the whole reason ink looks like ink and not like a spray. A here is
   not constant (it rotates with azimuth), and |∇×A| ≈ 1/r ≈ 0.09 at the
   spine, so the residual is small, smooth and non-noisy: it produces no
   point sources and no sinks, nothing that could pop. The high-frequency
   detail this single octave gives up is bought back by the sprite atlas,
   which is where real ink sims keep their detail anyway. */
vec3 inkCurl(vec3 p, vec3 axis) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.55;
  vec3 g = k.xyy * snoise3(p + k.xyy * e)
         + k.yyx * snoise3(p + k.yyx * e)
         + k.yxy * snoise3(p + k.yxy * e)
         + k.xxx * snoise3(p + k.xxx * e);
  return cross(g * (0.25 / e), axis);
}

/* ---- the lifecycle, shared VERBATIM by both sim shaders --------------
   Age is normalised, so a particle's lifespan never leaves this function
   and the render pass never has to guess at it. Written once and included
   twice on purpose: identical source text gives identical operation order,
   which is the only way to be sure two separately-compiled programs agree
   about the exact frame a particle dies. (They would disagree at worst by
   one ULP for one frame, but a simulation that is provably coherent needs
   no argument about how small its incoherence is.) */
void ageOf(vec2 uv, float dt, float surge, float prevAge,
           out float outAge, out float outBorn) {
  float life = LIFE_MIN + LIFE_VAR * hash12(uv * 91.7);
  /* A surge ages the whole field, so deaths — and therefore BIRTHS — come
     in a wave. That single multiply is the entire eruption mechanism. */
  float a = prevAge + (dt / life) * (1.0 + SURGE_AGE * surge);
  outAge = a;
  outBorn = step(1.0, a);
}

/* ---- the respawn law, run IDENTICALLY by both sim shaders ------------
   Randomness comes from the texel plus the CURRENT clock, so successive
   lives of the same particle never repeat, and both shaders — which hold
   the same uTime uniform object by reference — derive the same numbers.
   mod() keeps the clock small enough that hashing it stays
   well-conditioned after an hour on the page.

   Out-parameters rather than a returned struct: identical cost, and it
   sidesteps every driver that ever fumbled struct returns in ES 1.00.
   Note that outPos does NOT depend on intensity — only the impulse does —
   which is why the position shader may pass any value for it. */
void birthOf(vec2 uv, float clock, float progress, float intensity,
             float surge, out vec3 outPos, out vec3 outVel, out float outT) {
  vec2 hs = uv * 91.7 + mod(clock, 97.0);
  float rSel  = hash12(hs * 1.31);
  float rNear = hash12(hs * 2.17);
  float rWide = hash12(hs * 3.71);
  float rJit  = hash12(hs * 5.23);
  float rAng  = hash12(hs * 7.13);
  float rSpd  = hash12(hs * 11.9);
  float rTan  = hash12(hs * 13.3);
  float rUp   = hash12(hs * 17.7);
  float rIn   = hash12(hs * 19.1);

  /* A MIXTURE, not a blend: 74% of births land inside a band riding the
     current progress (the eruption travels with you), 26% spread over the
     whole helix so the far reaches of the spiral are never bare. Blending
     the two randoms instead of selecting between them would correlate them
     and collapse the tails. */
  float tNear = clamp(progress + (rNear - 0.5) * (BAND_HALF * 2.0), 0.0, 1.0);
  float tBirth = mix(rWide, tNear, step(rSel, LOCAL_BIAS));

  vec3 sp = spineAt(tBirth);
  float ja = rAng * TWO_PI;
  vec3 pos = sp + vec3(cos(ja), (rJit - 0.5) * 2.0, sin(ja))
                  * (BIRTH_JIT * (0.35 + rJit));
  outPos = pos;
  outT = tBirth;

  /* Outward from the world axis — that is the direction that carries ink
     across the card ring — plus a tangential shear and a vertical spread.
     A fifth dives INWARD instead, so the core volume fills too and the
     spiral is not a hollow tube of smoke. */
  vec3 radial = normalize(vec3(pos.x, 0.0, pos.z) + vec3(1e-4, 0.0, 0.0));
  vec3 tang = vec3(-pos.z, 0.0, pos.x) / max(length(pos.xz), 0.001);
  float outward = mix(-0.45, 1.0, step(INWARD_FRAC, rIn));
  vec3 dir = radial * outward
           + tang * (rTan - 0.5) * 1.25
           + vec3(0.0, (rUp - 0.35) * 1.15, 0.0);
  float speed = BIRTH_SPEED
    * (0.35 + rSpd * rSpd * 1.5)          // skewed: mostly gentle, some violent
    * (0.55 + 0.75 * intensity)
    * (1.0 + SURGE_KICK * surge);

  outVel = normalize(dir + 1e-5) * speed;
}
`;

/* ---- position: integrate, age, respawn ------------------------------ */
export const mistPositionShader = /* glsl */ `
uniform float uDelta;
uniform float uTime;
uniform float uMotion;
uniform float uSurge;
uniform float uProgress;

${glslNoiseCommon}
${glslSnoise3}
${glslHash}
${glslMistSim}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posAge = texture2D(texturePosition, uv);
  vec4 velBirth = texture2D(textureVelocity, uv);

  /* uMotion is 0 under prefers-reduced-motion: dt collapses, the field
     holds the pose it was seeded with, and only colour keeps living. */
  float dt = min(uDelta, 0.033) * uMotion;

  float age, born;
  ageOf(uv, dt, uSurge, posAge.w, age, born);

  vec3 pos = posAge.xyz + velBirth.xyz * dt;

  /* The 1.0 is the unused intensity: a spawn POINT does not depend on how
     hard the eruption throws, only the impulse does (see birthOf). */
  vec3 bPos, bVel;
  float bT;
  birthOf(uv, uTime, uProgress, 1.0, uSurge, bPos, bVel, bT);
  pos = mix(pos, bPos, born);
  age = mix(age, 0.0, born);

  gl_FragColor = vec4(pos, age);
}
`;

/* ---- velocity: curl advection, lift, drag, birth impulse ------------- */
export const mistVelocityShader = /* glsl */ `
uniform float uDelta;
uniform float uTime;
uniform float uMotion;
uniform float uSurge;
uniform float uProgress;
uniform float uIntensity;

${glslNoiseCommon}
${glslSnoise3}
${glslHash}
${glslMistSim}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posAge = texture2D(texturePosition, uv);
  vec4 velBirth = texture2D(textureVelocity, uv);

  vec3 pos = posAge.xyz;
  vec3 vel = velBirth.xyz;
  float dt = min(uDelta, 0.033) * uMotion;

  /* The same call the position shader makes, over the same inputs — see
     THE COHERENCE RULE at the top of this file. */
  float age, born;
  ageOf(uv, dt, uSurge, posAge.w, age, born);
  float aN = clamp(age, 0.0, 1.0);

  /* A purely cosmetic seed: it only offsets this particle's window into
     the noise field, and nothing reads it back. */
  float seed = hash12(uv * 91.7);

  /* Per-particle offset into the noise field so 16k particles sharing one
     octave never march in lockstep. */
  vec3 np = pos * NOISE_SCALE + vec3(0.0, uTime * NOISE_DRIFT, seed * 31.0);
  vec3 curl = inkCurl(np, swirlAxis(pos)) * CURL_GAIN;

  /* Young ink is violent and dense; old ink has thinned and only drifts —
     and it drifts UP, past a camera that is descending, which is what
     makes the fall read as a fall. */
  vel += curl * (0.45 + 0.90 * (1.0 - aN)) * dt;
  vel.y += LIFT * (0.35 + 0.90 * aN) * dt;
  vel *= exp(-DRAG * dt);

  vec3 bPos, bVel;
  float bT;
  birthOf(uv, uTime, uProgress, uIntensity, uSurge, bPos, bVel, bT);
  vel = mix(vel, bVel, born);
  float birthT = mix(velBirth.w, bT, born);

  gl_FragColor = vec4(vel, birthT);
}
`;

/* ------------------------------------------------------------------ */
/* render: one additive Points pass                                    */
/* ------------------------------------------------------------------ */

export const mistVertex = /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uSizeK;      // framebuffer px per world unit at 1 unit of depth
uniform float uSizeScale;  // tier normalisation × art direction
uniform float uIntensity;
uniform float uSurge;
uniform float uGain;
uniform float uSpin;       // world rig angular velocity, rad/s
uniform float uRise;       // world rig vertical velocity, units/s
uniform float uLead;
uniform vec3 uEraColors[6];
uniform vec3 uAmbientTint;

varying vec3 vColor;
varying vec2 vCell;
varying vec2 vSmear;
varying float vAmp;
varying float vCore;

${glslHash}
${glslLuma}

/* ---- look ---------------------------------------------------------- */
const float SIZE_MIN   = 0.16;   // world-unit sprite diameter, floor
const float SIZE_VAR   = 1.15;
const float SIZE_SKEW  = 2.4;    // heavy skew: a haze of motes, a few plumes
const float SIZE_CLAMP = 150.0;  // framebuffer px — the overdraw backstop
const float SMEAR_K    = 0.055;  // rig speed → stretch
const float SMEAR_MAX  = 2.2;
const float HUE_DRIFT  = 0.10;   // era-coordinate wander over a life
const float SAT_PUSH   = 1.50;   // past the source tint, so bloom bites
const float AMBIENT_MIX = 0.22;  // …then a breath of the era you are IN
const float FADE_NEAR  = 44.0;   // depth manners: no bright wall at the back
const float FADE_FAR   = 92.0;
const vec2  CELL = vec2(0.25, 0.5);   // 4 × 2 sprite atlas

/* The era of a HEIGHT, as a tent-basis blend of the six tints. Constant
   indices only — dynamic indexing of a uniform array is not guaranteed in
   GLSL ES 1.00, and the unrolled form is a handful of mads anyway. The
   coordinate matches js/eras.js: era i sits at t = i/5. */
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
  vec2 ref = position.xy;               // the particle's texel, not a place
  vec4 posAge = texture2D(uPos, ref);
  vec3 p = posAge.xyz;
  float aN = posAge.w;
  float birthT = texture2D(uVel, ref).w;

  /* Cosmetic seeds — decorrelated so the big sprites are not always the
     same plume, and the bright ones are not always the big ones. */
  float sSize = hash12(ref * 91.7);
  float sGate = hash12(ref * 37.3 + 11.0);
  float sLook = hash12(ref * 53.9 + 29.0);

  /* uIntensity thins the field by a SOFT seeded threshold, so ramping it
     fades particles in and out instead of popping the whole cloud. */
  float gate = smoothstep(0.0, 0.16, uIntensity * 1.12 - sGate);

  /* ---- colour: the era of the BIRTH HEIGHT ------------------------- */
  /* The sample point wanders a little over the particle's life, so a plume
     is never one flat colour — time moves through the ink. */
  float era = birthT + (sLook - 0.5) * HUE_DRIFT * aN;
  vec3 base = mix(eraColorAt(era), uAmbientTint, AMBIENT_MIX);
  vColor = max(mix(vec3(luma(base)), base, SAT_PUSH), 0.0);

  /* ---- amplitude: everything constant across the sprite ------------- */
  /* Fast bloom in, long thinning out. */
  float envA = smoothstep(0.0, 0.07, aN) * (1.0 - smoothstep(0.30, 1.0, aN));

  /* ---- the world rig's own velocity, in VIEW space ------------------
     The group spins about Y and rises; a point at local p therefore moves
     at ω·(ŷ × p) + ŷ·ẏ, and ŷ × p = (p.z, 0, −p.x). Rotation about Y
     leaves ŷ fixed, so the rise term rides through the model matrix
     untouched and both terms can be transformed in one go. */
  vec3 rigLocal = vec3(p.z, 0.0, -p.x) * uSpin + vec3(0.0, uRise, 0.0);
  vec3 rigView = (modelViewMatrix * vec4(rigLocal, 0.0)).xyz;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xyz += rigView * uLead;             // a slight lean into the motion
  float depth = -mv.z;

  /* Young ink is compact, old ink has spread and thinned. */
  float worldD = (SIZE_MIN + SIZE_VAR * pow(sSize + 1e-4, SIZE_SKEW))
    * uSizeScale
    * (0.75 + 0.55 * uIntensity + 0.50 * uSurge)
    * (0.55 + 1.05 * aN);

  /* Point sprites cannot rotate, so speed buys SIZE here and the fragment
     shader stretches the sampled texture along the motion axis. */
  float smear = clamp(length(rigView.xy) * SMEAR_K, 0.0, SMEAR_MAX);
  float sz = uSizeK * worldD / max(depth, 0.05) * (1.0 + smear * 0.85);
  gl_PointSize = clamp(sz * gate, 0.0, SIZE_CLAMP);

  /* Screen direction of the motion. projectionMatrix's diagonal carries
     the aspect/fov scaling; gl_PointCoord.y runs DOWN, hence the flip. */
  vec2 md = vec2(rigView.x * projectionMatrix[0][0],
                 -rigView.y * projectionMatrix[1][1]);
  vSmear = (md / max(length(md), 1e-4)) * smear;

  float cell = floor(sLook * 8.0);
  vCell = vec2(mod(cell, 4.0), floor(cell * 0.25)) * CELL;

  vAmp = uGain * gate * envA
    * (0.55 + 0.90 * uIntensity + 0.80 * uSurge)
    * (0.55 + 0.90 * sSize)
    * smoothstep(0.55, 3.40, depth)                       // nothing on the lens
    * (1.0 - smoothstep(FADE_NEAR, FADE_FAR, depth) * 0.88);

  /* Bright ink photographs with a blown core: the densest part of a young
     sprite burns toward firefly gold rather than saturating its own hue. */
  vCore = 0.30 + 0.35 * (1.0 - aN);

  gl_Position = projectionMatrix * mv;
}
`;

export const mistFragment = /* glsl */ `
uniform sampler2D uSprite;

varying vec3 vColor;
varying vec2 vCell;
varying vec2 vSmear;
varying float vAmp;
varying float vCore;

const vec2 CELL = vec2(0.25, 0.5);
const float INSET = 0.006;                     // half a texel, times a little
const vec3 SPARK = vec3(1.0, 0.8148, 0.6276);  // #FFE9C4, linear-sRGB

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;

  /* Velocity smear. Squeezing the SAMPLE coordinates along the motion axis
     stretches the drawn sprite along it — the lookup does the rotating the
     point sprite cannot. Degenerate at zero smear by construction: ax
     collapses to (0,0), al to 0, and pc survives untouched. No branch. */
  float s = length(vSmear);
  vec2 ax = vSmear / max(s, 1e-4);
  float al = dot(pc, ax);
  pc = (pc - ax * al) + ax * (al / (1.0 + s));

  /* Sub-rect of the 4 × 2 atlas, inset so bilinear never bleeds across a
     cell edge (the cells fade to black there anyway — belt and braces). */
  vec2 cuv = clamp(pc * 0.5 + 0.5, 0.0, 1.0);
  vec2 uv = vCell + (INSET + cuv * (1.0 - 2.0 * INSET)) * CELL;
  float mask = texture2D(uSprite, uv).r;

  /* A round envelope reaches zero before the rim, so a supplied PNG with
     content running off its edges can never show a square seam. It is set
     LATE on purpose — the real plumes are photographs whose value is their
     ragged silhouette, and discing them at 0.74 of the radius would turn
     every sprite back into the soft blob this whole file exists to avoid.
     Fading from 0.84 to 1.01 of the radius keeps the silhouette and still
     lands at zero before the quad edge, where a seam could show. */
  float d2 = dot(pc, pc);
  mask *= 1.0 - smoothstep(0.70, 1.02, d2);

  /* The atlas is intensity DATA (NoColorSpace), so gamma is ours to choose.
     The delivered plumes are dense — large areas near white — and at ~5×
     additive overlap that would read as milk. 1.85 sits the body well back
     while leaving the cores hot, which is what makes density, not
     brightness, decide what blooms. */
  mask = pow(mask, 1.85);
  if (mask < 0.002) discard;

  vec3 col = mix(vColor, SPARK, mask * mask * vCore);
  gl_FragColor = vec4(col * (mask * vAmp), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
