/* card.glsl.js — the glass-lantern card program: ONE compiled program for
   all 14 cards (identical source + defines → three.js's program cache
   shares it; only uniform values differ per card).

   Shared uniforms (same object references across every card material):
     uTime      seconds, accumulated in spiral.update
     uVelocity  signed angular velocity (rad/s): scroll descent + drag spin
     uEraTint   ledger's interpolated era tint (linear-sRGB THREE.Color)
     uFocus     0..1 — dims non-focused cards (U8 consumes; default 0)
     uPointer   damped pointer from app.js, [-1, 1] each axis
     uBreathe   1 normally, 0 under prefers-reduced-motion

   Per-card uniforms:
     uMap uDepth uHasDepth uAspect uReveal uSeed uVideoMix uVideo uLit
     (uVideo defaults to the card's placeholder — never an unbound sampler;
     js/focus.js swaps in a VideoTexture only while the card is staged)

   Per-card size uniforms (orientation-aware glass — landscape photos get
   landscape slides; uniforms rather than defines so all 14 cards still
   compile ONE shared program):
     uCardAspect  card width / height
     uCardHalfW   half the card width in world units

   Precision: three's ShaderMaterial prefix declares `precision highp
   float;` for both stages — nothing here re-declares it.

   Fragment texture-tap budget (uDepth 1 tap always):
     rest, revealed:          1 + 1        =  2
     revealing (0.9s):        1 + 1 + 8    = 10
     full velocity, revealed: 1 + 5 + 2    =  8
     full velocity+revealing: 1 + 7 + 8    = 16   (worst case, ≤ 18)
     focus video (U8):        +1 uVideo tap, gated on uVideoMix > 0.001 —
     the helix at rest pays nothing; only the staged card ever takes it.   */

import { glslHash, glslLuma, glslSoftclip } from './chunks.glsl.js';

export const cardVertex = /* glsl */ `
uniform float uTime;
uniform float uVelocity;
uniform float uSeed;
uniform float uBreathe;
uniform float uCardHalfW;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;

#include <fog_pars_vertex>

void main() {
  vUv = uv;
  vec3 pos = position;
  float xn = uv.x * 2.0 - 1.0; // -1 .. +1 along local X (tangent of travel)

  /* Drag-bow: velocity flexes the plate around its vertical axis, like a
     pane catching air. (xn² − ⅓) is zero-mean, so the card's anchored
     position never drifts. Seeded gain: no two cards flex in lockstep. */
  float flex = clamp(uVelocity * 0.085, -0.5, 0.5)
             * (0.85 + 0.3 * sin(uSeed * 12.9898));
  pos.z += flex * (xn * xn - 0.3333);

  /* High-velocity ripple: a faint traveling wave, silent at rest. */
  pos.z += clamp(abs(uVelocity) * 0.018, 0.0, 0.05)
         * sin(xn * 3.1416 + uTime * 9.0 + uSeed);

  /* Breathing: ±0.008 units, slow sine — cards are never dead-still.
     uBreathe = 0 under prefers-reduced-motion. */
  pos.z += 0.008 * uBreathe * sin(uTime * 0.7 + uSeed * 6.2832);

  /* Analytic slope of the bow bends the normal, so a flexing card
     honestly catches rim light while it moves. */
  float dzdx = flex * 2.0 * xn / uCardHalfW;
  vNormal = normalize(normalMatrix * normalize(vec3(-dzdx, 0.0, 1.0)));

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

export const cardFragment = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform sampler2D uVideo;
uniform float uHasDepth;
uniform float uAspect;
uniform float uCardAspect;
uniform float uReveal;
uniform float uSeed;
uniform float uVideoMix;
uniform float uLit;
uniform float uTime;
uniform float uVelocity;
uniform vec3  uEraTint;
uniform float uFocus;
uniform vec2  uPointer;
/* U10 outro: per-card dissolve, 1 everywhere except the final memory while
   the ending plays (js/outro.js). Fades alpha only — the glass simply
   stops being there, it does not turn grey. */
uniform float uFade;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;

${glslLuma}
${glslHash}
${glslSoftclip}

#include <fog_pars_fragment>

/* Palette, pre-converted to linear-sRGB (this shader runs before ACES
   tonemapping + the sRGB output transform). */
const vec3 AMBER = vec3(1.0, 0.4793, 0.1301);  // #FFB865 lamplight amber
const vec3 SPARK = vec3(1.0, 0.8148, 0.6276);  // #FFE9C4 firefly gold

void main() {
  vec2 c = vUv - 0.5;

  /* ---- cover-fit the photo, with a 4.5% protective zoom-in so depth
          parallax can never drag the photo border into view ------------- */
  vec2 fit = (uAspect > uCardAspect)
    ? vec2(uCardAspect / uAspect, 1.0)
    : vec2(1.0, uAspect / uCardAspect);
  vec2 pUv = c * fit * 0.9569 + 0.5;

  /* ---- depth parallax (1 tap) -------------------------------------- */
  /* Real depth map when present; otherwise a soft radial pseudo-depth
     bulging from the uv center. Edges stay safe: zoom above + clamp. */
  float dTex = texture2D(uDepth, pUv).r;
  float dPro = clamp(1.0 - length(c) * 1.35, 0.0, 1.0) * 0.8 + 0.1;
  float depth = mix(dPro, dTex, uHasDepth);
  pUv = clamp(pUv + uPointer * (depth - 0.5) * 0.03, 0.002, 0.998);

  /* ---- velocity ------------------------------------------------------
     THE PHOTOGRAPH IS NEVER BLURRED. An earlier pass smeared and
     RGB-split the image while scrolling; it read as a focus problem
     rather than as speed, and these are the only 14 photographs the site
     has. Motion now lives entirely OUTSIDE the frame — the ink plumes
     smear, the thread streaks, the rim brightens — while the picture
     itself stays exactly as sharp as it was scanned. */
  float speed = abs(uVelocity);
  float streakAmt = smoothstep(0.18, 2.2, speed);

  /* ONE tap, always the sharp one. */
  vec3 photo = texture2D(uMap, pUv).rgb;

  /* Speed still reads — as light spilling off the glass, never as a
     softer picture: the plate's own luminance feeds the rim glow below. */
  float glow = luma(photo) * streakAmt * 0.22;

  /* ---- focus depth-of-field (8 taps, only while a card is staged) ----
     The blur-up on texture arrival is gone along with the scroll smear:
     a photograph is sharp from the first frame it exists. This path
     survives for focus mode alone, where the unstaged cards genuinely
     should fall out of focus behind the staged glass. */
  float reveal = 1.0 - uFocus * 0.6 * (1.0 - uLit);
  if (reveal < 0.999) {
    float r = 0.014;
    float d7 = r * 0.7071;
    vec3 blurAcc = photo * 0.20; // center tap = the base path above
    blurAcc += texture2D(uMap, clamp(pUv + vec2( r,  0.0), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2(-r,  0.0), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2(0.0,  r ), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2(0.0, -r ), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2( d7,  d7), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2( d7, -d7), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2(-d7,  d7), 0.0, 1.0)).rgb * 0.10;
    blurAcc += texture2D(uMap, clamp(pUv + vec2(-d7, -d7), 0.0, 1.0)).rgb * 0.10;
    photo = mix(blurAcc * 0.85, photo, smoothstep(0.0, 1.0, reveal));
  }

  /* ---- U8 living photo: the staged card cross-fades to its video ------ */
  /* One extra tap, hard-gated: every non-staged card (uVideoMix = 0)
     skips the read entirely. uMap keeps the photo for the close tween. */
  if (uVideoMix > 0.001) {
    photo = mix(photo, texture2D(uVideo, pUv).rgb, uVideoMix);
  }

  /* ---- film response ------------------------------------------------ */
  /* Soft highlight shoulder, tiny lifted blacks, then 12% era warmth as a
     luminance-neutral hue grade weighted into shadows/mids — NEVER a flat
     multiply wash. */
  photo = softclipAbove(photo, 0.78);
  photo = photo * 0.96 + 0.012;
  vec3 tintN = uEraTint / max(luma(uEraTint), 1e-3);
  float pl = luma(photo);
  photo = mix(photo, photo * tintN, 0.12 * (1.0 - 0.5 * smoothstep(0.4, 1.0, pl)));

  /* ---- living grain (micro-motion mandate) -------------------------- */
  float grain = hash12(vUv * 617.3 + vec2(fract(uTime * 0.37) * 41.7, uSeed));
  photo += (grain - 0.5) * 0.018;

  /* ---- uLit: the current card burns +12%, far cards sink dimmer ----- */
  float exposure = mix(0.88, 1.12, uLit);
  exposure *= 1.0 - uFocus * 0.45 * (1.0 - uLit); // U8 focus dim hook
  photo *= exposure;

  /* ---- additive golden streak highlights ---------------------------- */
  photo += AMBER * glow * 0.85;

  /* ---- back face: frosted glass, never a mirrored photo -------------- */
  /* Cards across the axis show their backs; a real glass slide reads as
     frost from behind, and mirrored text would break the illusion. Rim,
     frame, vignette and fog below still apply, so backs stay premium. */
  if (!gl_FrontFacing) {
    float bg = 0.5 + 0.5 * vUv.y;
    vec3 frost = mix(vec3(0.045, 0.050, 0.105), uEraTint * 0.22, 0.30 * bg);
    frost += (grain - 0.5) * 0.030;
    photo = frost * mix(0.88, 1.08, uLit);
  }

  /* ---- glass-lantern body ------------------------------------------- */
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  float fres = pow(1.0 - abs(dot(N, V)), 3.0); // abs: DoubleSide-safe
  vec2 e = abs(vUv * 2.0 - 1.0);
  float vEdge = smoothstep(0.55, 0.98, e.x); // the two vertical edges
  float rim = fres * (0.45 + 0.55 * vEdge) + vEdge * 0.05;
  vec3 rimTint = mix(SPARK, uEraTint, 0.5);
  vec3 color = photo + rimTint * rim * (0.55 + 0.5 * uLit);

  /* 1.5%-width brighter glass border frame (e-space 0.03 = 1.5% card) */
  float edgeMax = max(e.x, e.y);
  float frame = smoothstep(0.97, 0.985, edgeMax)
              * (1.0 - smoothstep(0.995, 1.0, edgeMax));
  color += rimTint * frame * (0.35 + 0.4 * uLit);

  /* faint inner vignette */
  color *= 1.0 - 0.14 * smoothstep(0.35, 1.0, dot(c, c) * 2.6);

  /* interior slightly translucent, thinner (more see-through) at the
     fresnel rim; the border frame reads near-solid. */
  float alpha = 0.96 - fres * 0.10;
  alpha = max(alpha, frame * 0.98);
  alpha *= uFade;   // U10: the last memory dissolving into the ending

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
