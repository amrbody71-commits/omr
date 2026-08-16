/* post.js — U6: the cinematic post chain. The composer replaces the direct
   renderer.render call and is where "looks like a AAA render" comes from:

     pass 1  RenderPass          scene → half-float buffer, LINEAR HDR
     pass 2  EffectPass          bloom (mipmap, half-res chain) + anamorphic
             (capable tiers)     streak on the hottest cores    [linear HDR]
     pass 3  EffectPass          FilmGrade: CA → ACES → era grade → S-curve
             (always, → screen)  → vignette → grain, then sRGB encode

   TONE-MAPPING WIRING (the load-bearing decision):
   three r170 compiles every material with NoToneMapping + linear output
   whenever it renders into a render target (WebGLRenderer.getParameters:
   `currentRenderTarget === null || isXRRenderTarget` is required for the
   renderer-level operator to apply) — so inside the composer the renderer's
   ACESFilmicToneMapping and sRGB conversion are BOTH inert, and pmndrs'
   EffectMaterial is `toneMapped: false` on top. Scene materials recompile
   automatically for the render-target variant (the renderer diffs cached
   toneMapping/outputColorSpace per material), which also turns this app's
   shader-side tonemapping_fragment/colorspace_fragment includes into no-ops
   inside the chain. ACES therefore runs EXACTLY ONCE, explicitly, inside
   FilmGrade (pass 3) via three's own ACESFilmicToneMapping() from
   <tonemapping_pars_fragment> — the same operator, same 1/0.6 exposure
   scale as the pre-U6 renderer path — on the composed linear-HDR frame.
   sRGB encoding also runs exactly once: the final pass renders to screen
   with ENCODE_OUTPUT, whose colorspace_fragment compiles to the sRGB OETF
   only for the canvas (intermediate passes compile it to identity).

   EXPOSURE: <tonemapping_pars_fragment> declares `uniform float
   toneMappingExposure`, and WebGLRenderer.setProgram writes
   renderer.toneMappingExposure into any program that uses that uniform on
   every material refresh (which is every frame here — other materials render
   in between). The ledger's per-frame exposure write therefore drives the
   FilmGrade ACES with zero extra wiring; setExposure() below just routes
   through the same renderer property.

   Blending happens in linear HDR BEFORE the single tone-map, so stacked
   additive glow (thread pulse, firefly cores) now rolls off filmically
   instead of summing already-mapped values — the one intended departure
   from the pre-U6 look, confined to overlapping-glow pixels. */

import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
} from 'postprocessing';
import { glslHash, glslLuma } from './shaders/chunks.glsl.js';

/* Edge CA in CSS pixels at the extreme corners (scaled by DPR in setSize). */
const CA_MAX_PX = 1.6;

/* ------------------------------------------------------------------ */
/* Anamorphic streak — a horizontal lens smear on the very brightest    */
/* points. Taps the bloom effect's mipmap-blurred texture instead of    */
/* the raw scene: 8 sparse taps on unblurred pixels would render a hot  */
/* 2-px pulse as a dotted line, while taps on the pre-blurred chain     */
/* stay continuous. The gate keeps it to the hottest blurred cores      */
/* (the Thread's leading pulse), so dim halos never smear.              */
/* ------------------------------------------------------------------ */

const streakFragment = /* glsl */ `
uniform sampler2D tBloom;
uniform float uIntensity;
uniform float uSpread;
uniform float uGate;

${glslLuma}

/* #FFB865 lamplight amber, pre-converted to linear (matches thread.js). */
const vec3 STREAK_TINT = vec3(1.0, 0.4793, 0.1301);

vec3 streakTap(const in vec2 uv, const in float offset, const in float weight) {
  vec3 b = texture2D(tBloom, vec2(uv.x + offset, uv.y)).rgb;
  /* soft gate toward uGate: full weight only near the hottest cores */
  return b * (weight * smoothstep(uGate * 0.35, uGate, luma(b)));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  /* 8 taps, symmetric, quadratic falloff — a wide horizontal smear. */
  vec3 s = vec3(0.0);
  s += streakTap(uv,  uSpread * 0.25, 0.28);
  s += streakTap(uv, -uSpread * 0.25, 0.28);
  s += streakTap(uv,  uSpread * 0.50, 0.16);
  s += streakTap(uv, -uSpread * 0.50, 0.16);
  s += streakTap(uv,  uSpread * 0.75, 0.08);
  s += streakTap(uv, -uSpread * 0.75, 0.08);
  s += streakTap(uv,  uSpread,        0.04);
  s += streakTap(uv, -uSpread,        0.04);
  outputColor = vec4(s * STREAK_TINT * uIntensity, 0.0);
}
`;

class AnamorphicStreakEffect extends Effect {
  constructor() {
    super('AnamorphicStreakEffect', streakFragment, {
      blendFunction: BlendFunction.ADD,
      uniforms: new Map([
        ['tBloom', new THREE.Uniform(null)],
        ['uIntensity', new THREE.Uniform(0.35)],
        ['uSpread', new THREE.Uniform(0.13)],   // half-width, UV units
        ['uGate', new THREE.Uniform(0.85)],
      ]),
    });
  }
}

/* ------------------------------------------------------------------ */
/* FilmGrade — the always-on merged pass: chromatic aberration fetches  */
/* (pre-tonemap, so the fringes are honest lens physics on HDR light),  */
/* the single ACES site, era white-balance, a gentle film S-curve,      */
/* dusk-tinted vignette, and animated luminance-weighted grain. ONE     */
/* fragment, 3 texture taps total.                                      */
/* ------------------------------------------------------------------ */

const filmGradeFragment = /* glsl */ `
#include <tonemapping_pars_fragment>

uniform float uTime;
uniform float uEraTemp;
uniform float uVignette;
uniform float uGrainLow;
uniform float uGrainHigh;
uniform float uCaPixels;
uniform float uContrast;

${glslHash}
${glslLuma}

/* #2A2140 dusk violet in linear — the vignette leans here, never to black. */
const vec3 DUSK = vec3(0.0204, 0.0152, 0.0513);

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 fromCenter = uv - 0.5;
  float rad = length(fromCenter) * 1.4142136;      /* 0 center → 1 corners */

  /* (c) chromatic aberration — radial, quadratic growth, dead middle 40% */
  float caW = smoothstep(0.4, 1.0, rad);
  caW *= caW;
  vec2 dir = fromCenter / max(rad * 0.7071068, 1e-5);
  vec2 off = dir * (uCaPixels * caW) * texelSize;
  vec3 hdr = vec3(
    texture2D(inputBuffer, uv + off).r,
    inputColor.g,
    texture2D(inputBuffer, uv - off).b
  );

  /* THE tone-mapping site of the whole app (see header). Reads the
     renderer-managed toneMappingExposure uniform — the era ledger's
     per-frame exposure write lands here. */
  vec3 color = ACESFilmicToneMapping(hdr);

  /* (d) era grade — white-balance from the ledger's colorTemp (0..1):
     warm lifts red/gold mids, cool lifts blue shadows, ±4% max. */
  float l0 = luma(color);
  float warm = clamp((uEraTemp - 0.5) * 2.0, 0.0, 1.0);
  float cool = clamp((0.5 - uEraTemp) * 2.0, 0.0, 1.0);
  float mids = 4.0 * l0 * (1.0 - l0);
  float shad = (1.0 - l0) * (1.0 - l0);
  color.r *= (1.0 + 0.040 * warm * mids) * (1.0 - 0.012 * cool * shad);
  color.g *=  1.0 + 0.014 * warm * mids;
  color.b *= (1.0 - 0.018 * warm * mids) * (1.0 + 0.040 * cool * shad);

  /* gentle contrast S-curve — film response on the mapped [0,1] range */
  vec3 curved = color * color * (3.0 - 2.0 * color);
  color = mix(color, curved, uContrast);

  /* (b) vignette — darken toward the corners, leaning into dusk violet
     rather than pure black; the middle stays untouched. */
  float vig = smoothstep(0.30, 1.05, rad) * uVignette;
  color = mix(color * (1.0 - vig), DUSK, vig * 0.18);

  /* (a) grain — zero-mean hash noise, regenerated per frame via uTime.
     Applied in an approx-display domain (gamma 2.2) so the authored
     amplitudes are perceptual, with strength inversely scaled by
     luminance: shadows breathe, highlights stay clean. */
  vec3 disp = pow(max(color, vec3(0.0)), vec3(0.4545));
  float g = hash12(floor(uv * resolution)
                 + vec2(fract(uTime * 0.9273) * 511.0,
                        fract(uTime * 0.5731) * 379.0)) - 0.5;
  float amp = mix(uGrainLow, uGrainHigh, smoothstep(0.05, 0.85, luma(disp)));
  disp += g * 2.0 * amp;
  color = pow(max(disp, vec3(0.0)), vec3(2.2));

  outputColor = vec4(color, inputColor.a);
}
`;

class FilmGradeEffect extends Effect {
  constructor() {
    super('FilmGradeEffect', filmGradeFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['uTime', new THREE.Uniform(0)],
        ['uEraTemp', new THREE.Uniform(0.6)],
        ['uVignette', new THREE.Uniform(0.32)],
        ['uGrainLow', new THREE.Uniform(0.045)],   // shadow grain
        ['uGrainHigh', new THREE.Uniform(0.012)],  // highlight grain
        ['uCaPixels', new THREE.Uniform(CA_MAX_PX)],
        ['uContrast', new THREE.Uniform(0.18)],
      ]),
    });
  }
}

/* ------------------------------------------------------------------ */

export function initPost(renderer, scene, camera, { bloom = true } = {}) {
  /* Half-float buffers: the scene renders LINEAR and unclamped, so the
     thread/firefly cores keep their >1 energy for bloom and the single
     ACES at the end — and the dark void never bands in 8 bits. */
  /* MSAA on the composer's own buffer. This was 0 — a performance choice
     made before the frame budget was known, and the reason every card
     edge, every ring and every quad boundary stair-stepped: an offscreen
     target ignores the renderer's `antialias` flag entirely, so without
     this the whole scene resolved unantialiased no matter what the
     context was created with.

     TWO samples, not four. Measured: 4× cost ~25% of the frame rate and
     immediately provoked a DPR demotion to 1.5, which loses more sharpness
     than the antialiasing recovers — pixel density improves textures, thin
     lines and type, while MSAA only touches polygon edges, and this scene
     is mostly soft additive falloffs with very few of those. 2× takes the
     worst of the stair-stepping off the card and ring edges for a fraction
     of the bandwidth, and leaves the budget where it buys more. */
  const msaa = Math.min(2, renderer.capabilities.maxSamples || 0);
  const composer = new EffectComposer(renderer, {
    multisampling: msaa,
    frameBufferType: THREE.HalfFloatType,
  });

  composer.addPass(new RenderPass(scene, camera));

  let bloomPass = null;   // the bloom+streak EffectPass — U7 toggles it
  let bloomOn = false;
  if (bloom) {
    /* Thresholded half-res bloom (mipmap chain starts at half res).
       0.72 on pre-tonemap linear luminance: the thread stripes and
       firefly cores (≥ ~1.0) halo, card ivory (≤ ~0.7 after tint and
       glass shading) stays clean. ADD, not the library's SCREEN
       default — screen misbehaves above 1.0 and this runs pre-ACES. */
    const bloomEffect = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      mipmapBlur: true,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.15,
      intensity: 0.85,
      radius: 0.68,
      levels: 6,
    });
    const streak = new AnamorphicStreakEffect();
    streak.uniforms.get('tBloom').value = bloomEffect.texture;
    bloomPass = new EffectPass(camera, bloomEffect, streak);
    composer.addPass(bloomPass);
    bloomOn = true;
  }

  const grade = new FilmGradeEffect();
  composer.addPass(new EffectPass(camera, grade));

  const uTime = grade.uniforms.get('uTime');
  const uEraTemp = grade.uniforms.get('uEraTemp');
  const uCaPixels = grade.uniforms.get('uCaPixels');

  /* Frozen grain under prefers-reduced-motion — everything else stays. */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* The chain issues several internal renders per frame; keep
     renderer.info spanning the WHOLE frame so ?stats stays truthful. */
  renderer.info.autoReset = false;

  let time = 0;

  return {
    /* Live state, not a boot snapshot — ?stats reads this after the
       governor may have flipped it via setBloom below. */
    get bloom() { return bloomOn; },

    /* U7 governor hook: disabling the EffectPass makes the composer skip
       it entirely (bloom mipmap chain AND the streak that taps it), which
       is the whole point of the demotion — the passes stay allocated so a
       toggle back on would be free. A bloom-less tier never built the
       pass; setBloom is then a safe no-op. */
    setBloom(on) {
      if (!bloomPass) return;
      bloomOn = !!on;
      bloomPass.enabled = bloomOn;
    },

    render(dt) {
      if (!reduced) {
        time = (time + dt) % 64;   /* wrapped: hash precision stays fine */
        uTime.value = time;
      }
      renderer.info.reset();
      composer.render(dt);
    },

    setSize(w, h) {
      composer.setSize(w, h);
      /* texelSize is in drawing-buffer pixels; rescale so the authored
         1.6px corner fringe means CSS pixels on any DPR. */
      uCaPixels.value = CA_MAX_PX * renderer.getPixelRatio();
    },

    setEraTemp(t) {
      uEraTemp.value = t;
    },

    /* Single source of truth for exposure stays the renderer property —
       the FilmGrade ACES reads it via the renderer-managed uniform. */
    setExposure(e) {
      renderer.toneMappingExposure = e;
    },
  };
}
