/* outro.glsl.js — THE ENDING: every program of the last act (js/outro.js
   builds the geometry, owns the uniforms and drives all of it from ONE
   number, p ∈ [0,1]).

   ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────
   Solid shaded geometry reads as a CG render. LIGHT, VOLUME and
   PHOTOGRAPHIC TEXTURE read as real. So the ending contains no surfaces:
   there is no lit object anywhere in this file. There are only
   phenomena — radial falloff, striation, streaming dust, a fan of rays,
   a plate of filmed gas — and every one of them ends in a smooth fade to
   NOTHING that the bloom and grain downstream (js/post.js) can chew on.
   The one literal photograph in the sequence (the last memory) is not
   drawn as a picture at the end: it is taken apart into motes that each
   carry ONE of its own pixels. The image becomes dust made of itself.

   ── THE SEVEN PROGRAMS ───────────────────────────────────────────────
     TAIL       the Thread of Light continuing past the last memory,
                unwinding off the helix and plunging down the axis INTO
                the aperture. A tube, but never read as one: Fresnel body,
                flowing stripes, a leading pulse that arrives at the tip
                on exactly the frame the threshold blows out.
     APERTURE   the eye of light. A handful of large camera-facing quads
                merged into ONE draw call, each carrying a different
                phenomenon in the aQuad attribute: the iris CORE with a
                pupil that fills with light, concentric RINGS with
                chromatic split at the rim, the RAYS fan (the filmed god-
                ray clip, the still plate, or procedural noise on the unit
                circle — whichever exists), and the HALO that is simply
                lit air. Every layer is zero at its own quad edge, so the
                aperture has NO silhouette at any size.
     MOTES      the last photograph coming apart. Per-mote colour is a
                vertex fetch of the card's OWN texture at that mote's uv.
     STREAM     dust falling INTO the aperture: an accelerating, spiralling
                inflow whose phase wraps, fading to nothing at both ends
                so the wrap can never pop.
     CASCADE    the beyond. Hundreds of glittering motes drifting downward
                past the camera, cool violet with rare gold glints,
                parallaxed by depth because they are real points in space.
     FLASH      the threshold. A screen-space bloom of light coming AT the
                lens, hottest where the aperture is — never a flat white
                card. THIS is what hides the scene change.
     BACKDROP   the deep field beyond: the filmed nebula (or the still, or
                a procedural cloud), cover-fitted to any aspect, its own
                luma used as the mask so the gaps stay empty space.

   MOTES, STREAM and CASCADE all end in gl_PointCoord and share ONE
   fragment program (outroSpriteFragment) — everything that differs
   between them is computed per-mote in the vertex stage, exactly the way
   js/shaders/core.glsl.js does its dust.

   Colour is written in linear-sRGB: these run before the single ACES +
   sRGB transform at the end of the chain (js/post.js). fog is OFF on
   every material here — additive light must fade toward NOTHING, never
   toward the fog colour — so depth manners are carried by hand where they
   are needed at all. Precision is never re-declared; three's ShaderMaterial
   prefix already does it. No dynamic loops anywhere (the fbm is unrolled,
   the layer select is a branch on a per-quad varying).

   Defines injected by js/outro.js (single source of truth for the box):
     BOX_H, BOX_HALF_H, BOX_FADE     the cascade's fall box + its end fade */

import { glslNoiseCommon, glslSnoise2, glslLuma } from './chunks.glsl.js';

/* The palette, pre-converted to linear-sRGB — the same three colours the
   thread, the pillar and the fireflies are made of, so the ending cannot
   disagree with the life it ends. */
const palette = /* glsl */ `
const vec3 C_AMBER  = vec3(1.0, 0.4793, 0.1301);   // #FFB865 lamplight amber
const vec3 C_GOLD   = vec3(1.0, 0.8148, 0.6276);   // #FFE9C4 firefly gold
const vec3 C_WHITE  = vec3(1.0, 0.9700, 0.9300);   // the threshold
const vec3 C_VIOLET = vec3(0.1600, 0.1000, 0.4200);
const vec3 C_ICE    = vec3(0.4200, 0.5000, 0.8600);
`;

/* ------------------------------------------------------------------ */
/* 1 — the tail: the thread continuing into the light                  */
/* ------------------------------------------------------------------ */

export const outroTailVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vFogDepth;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vFogDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const outroTailFragment = /* glsl */ `
uniform float uTime;
uniform float uHead;      // the leading pulse's position along the tail
uniform float uOpacity;
uniform float uFeed;      // how hard the tip burns as it enters the aperture
uniform float fogNear;
uniform float fogFar;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vFogDepth;

${palette}

void main() {
  /* uv.x runs along the tail: 0 where the last memory hung, 1 at the tip
     on the axis, inside the aperture. The flow keeps travelling DOWN. */
  float along = vUv.x;

  float stripe = 0.5 + 0.5 * sin(along * 74.0 - uTime * 2.4);
  stripe *= stripe;

  /* The body gives out as the thread leaves the life behind… */
  float taper = 1.0 - smoothstep(0.02, 0.88, along);
  taper *= taper;

  /* …and then RE-IGNITES at the tip: the last of the light arriving where
     it is going. This is the whole point of the tail — it does not end,
     it is received. */
  float feed = smoothstep(0.62, 1.0, along) * uFeed;

  /* The leading pulse rides on past the final card and reaches the tip at
     the threshold (js/outro.js drives uHead so that lands on the flash). */
  float d = (along - uHead) / 0.045;
  float head = exp(-d * d);

  vec3 col = mix(C_AMBER, C_GOLD, 0.28 + 0.42 * stripe)
           * (0.34 + 0.66 * stripe) * taper * 1.25;
  col += C_GOLD * head * 1.5;
  col += mix(C_GOLD, C_WHITE, 0.5) * feed * feed * 2.2;

  /* Fresnel body, exactly as the thread does it. */
  float facing = abs(dot(normalize(vNormal), normalize(-vViewPos)));
  col *= pow(facing, 1.7);

  /* Additive depth manners: fade toward NOTHING, never toward fogColor. */
  col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth) * 0.9;

  gl_FragColor = vec4(col * uOpacity, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* 2 — the aperture: the eye of light                                  */
/* ------------------------------------------------------------------ */

/* Every layer is one quad of the same merged geometry, billboarded by
   offsetting its corners in VIEW space around one shared world anchor —
   the js/particles.js nebula pattern, so the whole aperture is a single
   draw call and no layer can ever show a seam or turn edge-on. */
export const outroApertureVertex = /* glsl */ `
attribute vec4 aQuad;    // x kind · y scale (× uRadius) · z gain · w phase

uniform vec3 uAnchor;    // world position of the aperture (on the axis)
uniform float uRadius;   // world half-extent of the CORE layer

varying vec2 vUv;
varying vec4 vQuad;

void main() {
  vUv = uv;
  /* constant across each quad's four vertices — interpolation is exact */
  vQuad = aQuad;
  vec4 mv = modelViewMatrix * vec4(uAnchor, 1.0);
  mv.xy += position.xy * (aQuad.y * uRadius);
  gl_Position = projectionMatrix * mv;
}
`;

export const outroApertureFragment = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform float uOpen;     // 0 → 1: the pupil filling with light
uniform float uCa;       // chromatic split at the rim, grows on approach
uniform float uGain;
uniform float uHasRays;  // 0 → procedural fan; 1 → the plate/clip below
uniform sampler2D uRays; // light-shafts.mp4, light-rays.png, or a white 1×1
uniform vec3 uTint;      // the era ledger's live tint — the life's colour

varying vec2 vUv;
varying vec4 vQuad;

${glslNoiseCommon}
${glslSnoise2}
${palette}

/* the iris: a gaussian annulus — a ring of light with no edge at all */
float iris(float r) {
  float d = (r - 0.46) / 0.17;
  return exp(-d * d);
}

/* concentric shells, drifting outward */
float shells(float r, float phase) {
  float b = 0.5 + 0.5 * sin(r * 19.0 - phase);
  b *= b;
  return b * b;
}

void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q);
  /* EVERY layer ends at nothing inside its own quad: the aperture has no
     silhouette at any size, and the corners never rasterise. */
  float edge = 1.0 - smoothstep(0.86, 1.0, r);
  if (edge <= 0.0) discard;

  vec3 col = vec3(0.0);

  if (vQuad.x < 0.5) {
    /* ---- CORE: the eye. A bright iris around a pupil that FILLS with
       light as the fall arrives — the aperture opens by becoming solid
       light, which is also how it swallows the frame at the threshold. */
    float rr = iris(r * (1.0 + uCa));
    float gg = iris(r);
    float bb = iris(r * (1.0 - uCa));
    col = vec3(rr, gg, bb) * mix(C_AMBER, C_GOLD, 0.55) * 1.45;
    float pupil = (1.0 - smoothstep(0.0, 0.52, r)) * uOpen;
    col += C_WHITE * pupil * pupil * 2.1;
    col += C_GOLD * exp(-r * r * 26.0) * (0.35 + 0.9 * uOpen);
  } else if (vQuad.x < 1.5) {
    /* ---- RINGS: shells of light around the eye, split into colour at
       the rim — lens physics, not decoration: it is what tells you the
       light is now closer than the lens can hold. */
    float phase = uTime * 0.55 + vQuad.w;
    float rr = shells(r * (1.0 + uCa * 1.6), phase);
    float gg = shells(r, phase);
    float bb = shells(r * (1.0 - uCa * 1.6), phase);
    float env = smoothstep(0.10, 0.34, r) * (1.0 - smoothstep(0.42, 1.0, r));
    col = vec3(rr, gg, bb) * mix(uTint, C_GOLD, 0.5) * env * 0.9;
  } else if (vQuad.x < 2.5) {
    /* ---- RAYS: the fan pouring out of the aperture. The delivered clip
       converges at ONE corner, so the uv is mirrored (abs) — the hot
       point lands dead centre and the fan opens into all four quadrants;
       a transposed second tap breaks the four-fold symmetry so the
       mirror never reads as a mirror, and the whole field rotates. */
    float a = uTime * 0.035 + vQuad.w;
    float cs = cos(a);
    float sn = sin(a);
    vec2 rq = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
    float fan;
    /* Branch on a UNIFORM, not on data: every fragment in the frame takes
       the same side, so this is free — and the noise fallback never costs
       a thing on the whiteout frame when the plate is actually there. */
    if (uHasRays > 0.5) {
      vec2 m = abs(rq) * 0.94;
      float t1 = texture2D(uRays, m).r;
      float t2 = texture2D(uRays, m.yx * 0.83 + 0.06).r;
      fan = (t1 * 0.62 + t2 * 0.38) * 2.4;
    } else {
      /* the unit circle fed to snoise2 is continuous all the way around —
         no atan, no ±π seam (the js/core.js rule) */
      vec2 dir = q / max(r, 1e-4);
      float f1 = snoise2(dir * 3.1 + vec2(a * 2.0, 0.0));
      float f2 = snoise2(dir * 6.7 + vec2(0.0, -a * 3.0));
      fan = max(0.0, 0.55 + 0.50 * f1 + 0.28 * f2);
    }
    float env = (1.0 - smoothstep(0.04, 0.95, r)) * smoothstep(0.0, 0.16, r);
    col = mix(C_AMBER, C_GOLD, 0.45) * fan * env * 0.80;
  } else {
    /* ---- HALO: lit air. The cheapest branch by construction — this is
       the layer that covers the frame. */
    float g = exp(-r * r * 3.4);
    col = mix(uTint, C_GOLD, 0.62) * g * (0.55 + 0.85 * uOpen);
  }

  gl_FragColor = vec4(col * vQuad.z * edge * uGain * uOpacity, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* 3 — the shared point fragment (motes · stream · cascade)            */
/* ------------------------------------------------------------------ */

export const outroSpriteFragment = /* glsl */ `
uniform sampler2D uSprite;   // spark-point.png, or a white 1×1 placeholder
uniform float uHasSprite;    // 0 until (and unless) the plate actually loads

varying vec3 vColor;

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  if (d2 > 1.0) discard;

  /* soft gaussian, guaranteed zero at the rim — the same curve the
     delivered sprite carries, drawn by hand when it is absent */
  float fall = exp(-d2 * 4.0) * (1.0 - d2 * d2);
  float shape = mix(fall, texture2D(uSprite, gl_PointCoord).r, uHasSprite);

  gl_FragColor = vec4(vColor * shape, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* 4 — the motes: the last photograph coming apart                     */
/* ------------------------------------------------------------------ */

/* THE IDEA: a mote's colour is a vertex fetch of the card's own texture
   at the mote's birth uv, so the dust is literally made of the picture.
   The uMap slot is the SAME live uniform object js/textures.js hands the
   card, so this can never sample an evicted or unbound texture. */
export const outroMoteVertex = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aUv;

uniform float uTime;
uniform float uP;          // 0 → 1: how far the dissolve has run
uniform float uOpacity;
uniform float uPixelRatio;
uniform sampler2D uMap;    // the card's OWN photograph (live uniform slot)
uniform vec3 uTint;

varying vec3 vColor;

void main() {
  /* Staggered release: every mote leaves on its own beat, so the picture
     comes APART instead of exploding. */
  float k = clamp((uP - 0.20 * aSeed.x) / 0.74, 0.0, 1.0);
  float e = k * k * (3.0 - 2.0 * k);

  /* Local frame: the card faces outward, so −z is inward — toward the
     axis, the pillar and the light waiting below. Away, and down. */
  vec3 p = position;
  p.x += (aSeed.y - 0.5) * 3.4 * e;
  p.y -= (1.1 + 3.4 * aSeed.z) * e * e;
  p.z -= (0.8 + 2.6 * aSeed.w) * e;

  float w = uTime * (0.25 + 0.50 * aSeed.x) + aSeed.y * 6.2831853;
  p.x += sin(w) * 0.22 * e;
  p.y += cos(w * 0.77) * 0.16 * e;

  /* the photograph's own pixel, with a warm floor so even its shadows
     leave an ember behind rather than nothing at all */
  vec3 pix = texture2D(uMap, aUv).rgb;
  float tw = 0.35 + 0.65 * (0.5 + 0.5
    * sin(uTime * (1.1 + 2.0 * aSeed.z) + aSeed.w * 6.2831853));
  /* born at the surface of the picture, giving out as it falls */
  float life = (1.0 - e) * smoothstep(0.0, 0.10, k);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vColor = (pix * 1.60 + uTint * 0.25) * tw * life * uOpacity;

  gl_PointSize = clamp((1.4 + 2.6 * aSeed.x) * uPixelRatio
                       * (24.0 / max(-mv.z, 0.1)),
                       1.0, 12.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
}
`;

/* ------------------------------------------------------------------ */
/* 5 — the stream: dust falling into the aperture                      */
/* ------------------------------------------------------------------ */

export const outroStreamVertex = /* glsl */ `
attribute vec4 aSeed;      // x phase · y rate · z size/shimmer · w tint

uniform float uTime;
uniform float uOpacity;
uniform float uPixelRatio;
uniform float uOuter;      // where a mote enters the pull
uniform float uInner;      // where it is finally taken

varying vec3 vColor;

${palette}

void main() {
  /* position carries this mote's approach DIRECTION (a unit vector,
     flattened in y at build). The inflow phase wraps, and both ends fade
     to nothing, so the wrap is invisible forever. */
  float f = fract(aSeed.x + uTime * (0.020 + 0.045 * aSeed.y));
  float pull = f * f;                       // it accelerates as it nears
  float rad = mix(uOuter, uInner, pull);

  /* …and spirals: light falling into light, never straight in */
  float a = pull * 2.3 + aSeed.x * 6.2831853;
  float cs = cos(a);
  float sn = sin(a);
  vec3 d = position;
  vec3 p = vec3(d.x * cs - d.z * sn, d.y, d.x * sn + d.z * cs) * rad;

  float env = smoothstep(0.0, 0.14, f) * (1.0 - smoothstep(0.72, 1.0, f));
  float tw = 0.5 + 0.5 * sin(uTime * (0.8 + 1.6 * aSeed.z)
                             + aSeed.w * 6.2831853);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vColor = mix(C_AMBER, C_GOLD, 0.30 + 0.60 * aSeed.w)
         * env * (0.40 + 0.80 * tw) * (0.35 + 1.50 * pull) * uOpacity;

  gl_PointSize = clamp((1.0 + 2.4 * aSeed.z) * uPixelRatio
                       * (26.0 / max(-mv.z, 0.1)),
                       1.0, 10.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
}
`;

/* ------------------------------------------------------------------ */
/* 6 — the cascade: the beyond                                         */
/* ------------------------------------------------------------------ */

export const outroCascadeVertex = /* glsl */ `
attribute vec4 aSeed;

uniform float uTime;
uniform float uOpacity;
uniform float uPixelRatio;
uniform float uRate;       // reduced motion slows the whole fall

varying vec3 vColor;

${palette}

void main() {
  vec3 p = position;

  /* Endless fall: each mote at its own speed, wrapped through the box.
     Depth does the parallax for free — these are real points in space,
     so the near ones sweep and the far ones barely move. */
  float speed = (0.45 + 1.75 * aSeed.x) * uRate;
  p.y = mod(p.y - uTime * speed + BOX_HALF_H, BOX_H) - BOX_HALF_H;

  float w = uTime * (0.08 + 0.18 * aSeed.y) + aSeed.z * 6.2831853;
  p.x += sin(w) * 0.5;
  p.z += cos(w * 0.83) * 0.5;

  float tw = 0.35 + 0.65 * (0.5 + 0.5
    * sin(uTime * (0.6 + 2.2 * aSeed.z) + aSeed.w * 6.2831853));
  /* mostly cool, with rare gold glints — the reference's deep field */
  float warm = smoothstep(0.72, 1.0, aSeed.w);
  vec3 tint = mix(mix(C_VIOLET, C_ICE, aSeed.y), C_GOLD, warm);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);

  /* the box never shows: motes fade at the wrap, at the far wall, and
     right in front of the lens (where one would be a plate of light) */
  float envY = 1.0 - smoothstep(BOX_FADE, BOX_HALF_H, abs(p.y));
  float envZ = smoothstep(1.2, 4.5, dist) * (1.0 - smoothstep(30.0, 44.0, dist));

  vColor = tint * tw * envY * envZ * (0.55 + 0.90 * aSeed.x) * uOpacity;

  gl_PointSize = clamp((1.3 + 3.4 * aSeed.z) * uPixelRatio * (22.0 / dist),
                       1.0, 14.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
}
`;

/* ------------------------------------------------------------------ */
/* 7 — screen space: the threshold and the deep field                  */
/* ------------------------------------------------------------------ */

/* A 2×2 plane written straight into clip space: no camera, no placement,
   no aspect maths, and it can never be culled or occluded. */
export const outroScreenVertex = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* THE THRESHOLD. Not a white card: a bloom of light coming AT the lens,
   hottest exactly where the aperture is on screen, falling off outward.
   js/outro.js drives uFlash as a gaussian in p — it cannot latch, and
   scrolling back up runs it backwards through the same curve. */
export const outroFlashFragment = /* glsl */ `
uniform float uFlash;    // peak energy, already gained
uniform vec2 uCenter;    // the aperture, in NDC
uniform float uAspect;

varying vec2 vUv;

${palette}

void main() {
  vec2 d = (vUv * 2.0 - 1.0) - uCenter;
  d.x *= uAspect;
  float r = length(d) * 0.62;

  float core = exp(-r * r * 1.5);
  float wide = exp(-r * r * 0.22);
  vec3 col = C_WHITE * core * 1.35 + mix(C_AMBER, C_GOLD, 0.6) * wide * 0.75;

  gl_FragColor = vec4(col * uFlash, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* THE DEEP FIELD. The filmed nebula if it arrives, the still plate if it
   does not, and a procedural cloud if neither ever does — the ending is
   never black and never stalls. Cover-fitted on any aspect; the plate's
   own luma is the mask, so its black gaps stay empty space instead of a
   grey rectangle. The branch is on a uniform: fully coherent, free. */
export const outroBackdropFragment = /* glsl */ `
uniform sampler2D uNebula;
uniform float uHasNebula;
uniform float uTexAspect;   // the plate's own w/h
uniform float uAspect;      // the viewport's
uniform vec2 uPan;          // parallax from where the camera is looking
uniform float uZoom;
uniform float uOpacity;
uniform float uTime;
uniform vec3 uTint;

varying vec2 vUv;

${glslNoiseCommon}
${glslSnoise2}
${glslLuma}
${palette}

const vec3 C_DUSK = vec3(0.0231, 0.0152, 0.0513);   // #2A2140 dusk violet

void main() {
  vec3 col;

  if (uHasNebula > 0.5) {
    /* COVER fit: whichever axis is short samples less of the plate, so
       the field fills the frame on every screen and never letterboxes. */
    vec2 scale = vec2(min(1.0, uAspect / uTexAspect),
                      min(1.0, uTexAspect / uAspect));
    vec2 uv = 0.5 + (vUv - 0.5) * scale / uZoom + uPan;
    vec3 plate = texture2D(uNebula, clamp(uv, 0.001, 0.999)).rgb;
    /* luma AS alpha, at low gain — the clip's mean sits near 0.36 */
    col = plate * smoothstep(0.03, 0.62, luma(plate)) * 1.25;
  } else {
    /* three octaves, unrolled, drifting imperceptibly */
    vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.4;
    float dr = uTime * 0.006;
    float f = 0.5 * snoise2(q + vec2(dr, -dr * 0.6));
    f += 0.25 * snoise2(q * 2.13 + vec2(-dr * 1.4, dr));
    f += 0.125 * snoise2(q * 4.37 + vec2(dr * 0.8, dr * 1.3));
    f = clamp(f * 0.62 + 0.5, 0.0, 1.0);
    float cloud = f * f;
    col = mix(C_DUSK, mix(C_VIOLET, uTint, 0.35), cloud) * (0.35 + 0.90 * cloud);
  }

  /* the field is deepest at the bottom: whatever light there is out here
     comes from above and behind, the way it did in the life */
  col *= 0.55 + 0.65 * smoothstep(-0.1, 1.0, vUv.y);

  gl_FragColor = vec4(col * uOpacity, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
