/* core.js — THE PILLAR: a column of pure light on the axis of the spiral.

   The previous core was solid geometry — dark glass, machined collars —
   and solid geometry with visible shading reads as a CG render. The
   reference's central presence is volumetric and luminous: LIGHT, not
   object. So this build has no surfaces at all. It is made of exactly
   four phenomena, all additive, all falloff, nothing with an edge:

     1 THE BEAM   nested coaxial open cylinders (no caps) merged into ONE
                  draw call: a hot slender core, a soft wide body, and on
                  the high tier a very faint sleeve that seeds a halo in
                  the surrounding air. Brightness is pure N·V falloff —
                  bright toward the axis, feathering to nothing — with
                  slow vertical striation falling DOWN at a different rate
                  on each shell (assets/textures/light-rays.png when it
                  exists, procedural noise when it does not — silently).
     2 THE DUST   one Points draw of tiny motes drifting very slowly
                  inside the column, brightest where the beam is
                  brightest. In-shader motion from seed + uTime: the CPU
                  never touches a mote. Dust is what makes the light read
                  as illuminated air instead of a gradient.
     3 THE BAND   the era marker: a soft gaussian band of brighter light
                  (~1.2 units tall) at the archive height y = 9 − 18·smooth,
                  tinted the current era colour, intensity just past the
                  0.72 bloom threshold (js/post.js) so it halos. A scanner
                  line living inside the column — where you are, made light.
     4 THE BREATH whole-pillar brightness, ±8% on a ~9s period. Frozen
                  under prefers-reduced-motion; the band keeps tracking —
                  it is information, not decoration.

   World-static in the strongest sense available: added to the SCENE, not
   to spiralGroup, so the world rig spins and raises the whole life around
   it (js/spiral.js) while the pillar holds still. That contrast is what
   makes the spiral's rotation legible — there is something to turn against.

   ── GEOMETRY CLEARANCE (nothing may ever intersect) ──────────────────
     beam core / body      0.35 / 0.90   (additive, depthWrite false)
     sleeve                2.20          (high tier only, ~5% peak)
     dust column           ≤ 1.38        (seed 1.22 + wander 0.16)
     outro thread tail     6.27          → 4.07 clear of the sleeve
     Thread of Light      11.40          → 9.20 clear of the sleeve
     card ring            14.00          → 11.80; with the cards' own
                                           inward shader displacement
                                           (≤ 0.44, js/thread.js) 11.36
     fireflies wander an annulus from 2.0 with ≤ 0.85 of drift, so one can
     reach ~1.15 from the axis and interleave with the dust column — both
     are additive Points with depthWrite false, so overlap is harmless
     (more motes among motes), never an intersection artifact.
   Nothing here writes depth. Cards crossing in front occlude the pillar
   correctly (depth TEST stays on); the pillar adds light everywhere else.

   ── COST ─────────────────────────────────────────────────────────────
   Draw calls: base 1 (beam, single shell) · mid 2 · high 2. Per-frame CPU
   is four float writes and one colour copy — zero allocation, ever.

   THE THREE TUNING CONSTANTS most likely to want a nudge on screen:
   BODY_GAIN (how bright the column body runs — the axis line sits just
   past the bloom threshold at 0.5), BAND_GAIN (the year band's punch —
   sized so even the dimmest era tint lands past 0.72), and FLOW (how fast
   the striation falls, world-units/second).

   NEVER THROWS. app.js awaits start() on the boot path; an ornament that
   cannot build must degrade to nothing rather than take the site down, so
   every failure lands on the inert stand-in — silently, with the same
   shape the caller expects (the js/mist.js contract). */

import * as THREE from 'three';
import {
  coreBeamVertex, coreBeamFragment,
  coreDustVertex, coreDustFragment,
} from './shaders/core.glsl.js';

/* ------------------------------------------------------------------ */
/* the dials                                                           */
/* ------------------------------------------------------------------ */

const BODY_GAIN = 0.5;    // master brightness of the column body
const BAND_GAIN = 1.35;   // the year band's push past the 0.72 threshold
const FLOW = 2.1;         // striation descent, world-units/second

/* BEAM_HEIGHT only has to exceed the view: the camera sits ~26 units out
   at fov ≈ 46, so it sees roughly ±11 world-units of the axis (±13.5 on
   the narrowest screens, and ~+10 more during the intro's high hold).
   140 is full-viewport top-to-bottom by an enormous margin, and the ends
   fade to nothing over their outer 15% anyway — a light column has no
   ends, so nobody may ever see one. */
const BEAM_HEIGHT = 140;

/* The shells. flow is each one's striation rate (× FLOW — the difference
   IS the parallax), gain its share of the light, stri how much striation
   modulates it, hot its share of the axis filament. The sleeve exists to
   seed a halo in the surrounding air: ~5% peak, almost subliminal. */
const SHELLS = {
  core: { r: 0.35, flow: 1.0, gain: 1.0, stri: 0.3, hot: 0.95 },
  body: { r: 0.9, flow: 0.55, gain: 0.55, stri: 0.55, hot: 0.15 },
  sleeve: { r: 2.2, flow: 0.32, gain: 0.1, stri: 0.35, hot: 0.0 },
};

/* The dust column: seeded to 1.22 of radius with ±0.16 of wander, so a
   mote can reach 1.38 and the volume reads ~1.4 wide. 56 units tall
   covers every camera pose including the intro hold, at ~3 motes per
   unit of height on the high tier. */
const DUST_RADIUS = 1.22;
const DUST_HEIGHT = 56;

/* The archive scale in world units: smooth = 0 at the top, 1 at the
   bottom, y = SCALE_TOP − smooth·SCALE_SPAN. The outro carries smooth to
   ~1.12, which walks the band below eye level and off the bottom of the
   frame — the life running out of scale, which is the right ending. */
const SCALE_TOP = 9;
const SCALE_SPAN = 18;
const SMOOTH_MAX = 1.14;
const BAND_SIGMA = 0.5;   // gaussian σ → the band reads ~1.2 units tall

/* A non-zero clock so a reduced-motion visit still gets a fully formed
   pattern — exactly one breath period (2π / 0.6981317 = 9s), so the
   frozen breath() holds at precisely 1.0. */
const TIME_SEED = 9.0;

const RAYS_URL = 'assets/textures/light-rays.png';
const SPARK_URL = 'assets/textures/spark-point.png';

/* Tier scaling. The base tier drops the dust and the outer body shell —
   the beam becomes the single hot core cylinder (its gain lifted ×1.35 to
   keep presence), one draw call, no texture-heavy striation overdraw.
   Mid adds the body shell and the dust; high adds the sleeve and the full
   mote count. Segment counts only shape the N·V interpolation. */
const TIERS = {
  base: { shells: ['core'], radialSegs: 40, dust: 0, soloGain: 1.35 },
  mid: { shells: ['core', 'body'], radialSegs: 48, dust: 140, soloGain: 1 },
  high: { shells: ['core', 'body', 'sleeve'], radialSegs: 64, dust: 180, soloGain: 1 },
};

/* The shipped palette (data/memories.json), used until — and only until —
   the orchestrator calls setEraColors with the ledger's own tints. Frame
   one is already right; it never waits to be told. */
const DEFAULT_ERAS = [
  '#FFD9A0', '#FFB865', '#E98FA0', '#B08CC4', '#7FB8B0', '#F4EFE6',
];

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

/* All shells in ONE indexed geometry — per-shell character travels in the
   aShell attribute (constant across each shell's vertices, so varying
   interpolation hands the fragment stage exact values). Vertex counts are
   tiny: ≤ (64+1)·2 per shell, three shells ≈ 390 vertices. */
function buildBeamGeometry(shellSpecs, radialSegs) {
  let vTotal = 0;
  let iTotal = 0;
  const parts = shellSpecs.map((spec) => {
    const geo = new THREE.CylinderGeometry(
      spec.r, spec.r, BEAM_HEIGHT, radialSegs, 1, true);
    vTotal += geo.attributes.position.count;
    iTotal += geo.index.count;
    return geo;
  });

  const position = new Float32Array(vTotal * 3);
  const normal = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const shell = new Float32Array(vTotal * 4);
  const index = new Uint16Array(iTotal);   // vTotal ≤ ~390 ≪ 65535

  let vo = 0;
  let io = 0;
  for (let s = 0; s < parts.length; s += 1) {
    const geo = parts[s];
    const spec = shellSpecs[s];
    const n = geo.attributes.position.count;
    position.set(geo.attributes.position.array, vo * 3);
    normal.set(geo.attributes.normal.array, vo * 3);
    uv.set(geo.attributes.uv.array, vo * 2);
    for (let i = 0; i < n; i += 1) {
      shell[(vo + i) * 4] = spec.flow;
      shell[(vo + i) * 4 + 1] = spec.gain;
      shell[(vo + i) * 4 + 2] = spec.stri;
      shell[(vo + i) * 4 + 3] = spec.hot;
    }
    const src = geo.index.array;
    for (let i = 0; i < src.length; i += 1) index[io + i] = src[i] + vo;
    io += src.length;
    vo += n;
    geo.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aShell', new THREE.BufferAttribute(shell, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/* Motes: base positions biased toward the axis (pow 0.62), where the beam
   is brightest; the shader adds the fall, the wander and the shimmer. */
function buildDustGeometry(count) {
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const ang = Math.random() * Math.PI * 2;
    const rad = DUST_RADIUS * Math.pow(Math.random(), 0.62);
    position[i * 3] = Math.sin(ang) * rad;
    position[i * 3 + 1] = (Math.random() * 2 - 1) * (DUST_HEIGHT / 2);
    position[i * 3 + 2] = Math.cos(ang) * rad;
    seed[i * 4] = Math.random();
    seed[i * 4 + 1] = Math.random();
    seed[i * 4 + 2] = Math.random();
    seed[i * 4 + 3] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  return geometry;
}

/* ------------------------------------------------------------------ */
/* the optional plates                                                 */
/* ------------------------------------------------------------------ */

/* A white 1×1, bound from frame one so no sampler is EVER unbound (the
   discipline js/spiral.js keeps for the card textures). */
function whitePixel() {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

async function grab(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || !blob.size) return null;
    return await createImageBitmap(blob);
  } catch (err) {
    return null;
  }
}

/* Intensity DATA, not colour: no sRGB decode, the shader shapes it.
   flipY stays false — ImageBitmap sources cannot be flipped on upload,
   and the beam's sampled v-band is chosen against the un-flipped plate. */
function plateTexture(bitmap, wrapS) {
  const tex = new THREE.Texture(bitmap);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.wrapS = wrapS;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/* ONE silent HEAD probe gates the whole batch (the js/mist.js contract:
   the plates are generated together, so a miss on the first means the
   batch is absent). A 404 is normal and is not an error; nothing is ever
   logged, and both programs simply keep their procedural falls. */
async function loadPlates(beamU, dustU, state) {
  try {
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return;
    const head = await fetch(RAYS_URL, { method: 'HEAD' });
    if (!head.ok || state.disposed) return;

    const rays = await grab(RAYS_URL);
    if (state.disposed) {
      if (rays && typeof rays.close === 'function') rays.close();
      return;
    }
    if (rays) {
      /* REPEAT around the circumference — the beam wraps it ×2 */
      const tex = plateTexture(rays, THREE.RepeatWrapping);
      state.plates.push(tex);
      beamU.uRays.value = tex;
      beamU.uHasRays.value = 1;
    }

    if (!dustU) return;   // base tier: no dust, no second fetch
    const spark = await grab(SPARK_URL);
    if (state.disposed) {
      if (spark && typeof spark.close === 'function') spark.close();
      return;
    }
    if (spark) {
      const tex = plateTexture(spark, THREE.ClampToEdgeWrapping);
      state.plates.push(tex);
      dustU.uSprite.value = tex;
      dustU.uHasSprite.value = 1;
    }
  } catch (err) {
    /* absent, blocked, or undecodable — the pillar never needed them */
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/* The inert stand-in: the exact same shape, doing nothing at all. */
function inertCore() {
  return {
    update() {},
    setEraColors() {},
    dispose() {},
  };
}

/* initCore(scene, quality, { renderer })
     → { update(TIMELINE, frame, dt), setEraColors(colors), dispose() }

   `renderer` is accepted for symmetry with the other world modules and is
   deliberately unused: nothing here needs the context's capabilities. */
export function initCore(scene, quality, options = {}) {
  try {
    return buildCore(scene, quality, options) || inertCore();
  } catch (err) {
    return inertCore();
  }
}

function buildCore(scene, quality) {
  if (!scene || typeof scene.add !== 'function') return inertCore();

  /* Reduced motion freezes the clock: striation, dust and breath hold a
     fully formed frame (TIME_SEED lands the breath at exactly 1.0). The
     band keeps tracking — it is information about where you are in the
     life, not decoration. */
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionScale = reduced ? 0 : 1;

  const tier = TIERS[(quality && quality.name)] || TIERS.mid;

  /* ---- shared uniforms: ONE object each, referenced by both materials —
     a single write per frame reaches every program. ------------------- */
  const eraColors = DEFAULT_ERAS.map((hex) => new THREE.Color(hex));
  const shared = {
    uTime: { value: TIME_SEED },
    /* the one number the frame loop actually tracks */
    uBandY: { value: SCALE_TOP },
    uEraColors: { value: eraColors },
    uEraTint: { value: new THREE.Color('#F4EFE6') },
    /* fog is false on both materials (additive light must fade toward
       nothing, not toward the fog colour), so the ledger's fog span is
       carried by hand — update() writes it every frame. */
    uFogNear: { value: 30 },
    uFogFar: { value: 76 },
  };

  /* Injected constants — js/core.js stays the single source of truth for
     the archive scale and every envelope the shaders fade inside. */
  const sharedDefines = {
    ARCH_TOP: SCALE_TOP.toFixed(1),
    ARCH_SPAN: SCALE_SPAN.toFixed(1),
    BAND_SIGMA: BAND_SIGMA.toFixed(2),
  };

  const disposables = [];
  const meshes = [];
  const state = { disposed: false, plates: [] };

  /* ---- 1 + 3 + 4: the beam (band and breath live in its fragment) ---- */
  const shellSpecs = tier.shells.map((name) => {
    const s = SHELLS[name];
    return { r: s.r, flow: s.flow, gain: s.gain * tier.soloGain, stri: s.stri, hot: s.hot };
  });
  const beamGeo = buildBeamGeometry(shellSpecs, tier.radialSegs);
  const beamU = {
    uTime: shared.uTime,
    uBandY: shared.uBandY,
    uEraColors: shared.uEraColors,
    uEraTint: shared.uEraTint,
    uFogNear: shared.uFogNear,
    uFogFar: shared.uFogFar,
    uFlow: { value: FLOW },
    uGain: { value: BODY_GAIN },
    uBandGain: { value: BAND_GAIN },
    uRays: { value: whitePixel() },
    uHasRays: { value: 0 },
  };
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: coreBeamVertex,
    fragmentShader: coreBeamFragment,
    defines: {
      ...sharedDefines,
      HALF_H: (BEAM_HEIGHT / 2).toFixed(1),
      END_FADE_IN: (BEAM_HEIGHT / 2 - BEAM_HEIGHT * 0.15).toFixed(1),
    },
    uniforms: beamU,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    /* depth TEST stays on: the beam is correctly hidden where a card
       passes in front of it, and only adds light where it is clear. */
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  /* After the depth-writing cards (renderOrder 0), alongside the thread. */
  beam.renderOrder = 1;
  /* It spans far more than the view in every pose — culling it is churn
     that can only ever answer "visible". */
  beam.frustumCulled = false;
  scene.add(beam);
  meshes.push(beam);
  disposables.push(beamGeo, beamMat, beamU.uRays.value);

  /* ---- 2: the dust ---------------------------------------------------- */
  let dustU = null;
  if (tier.dust > 0) {
    const dustGeo = buildDustGeometry(tier.dust);
    dustU = {
      uTime: shared.uTime,
      uBandY: shared.uBandY,
      uEraColors: shared.uEraColors,
      uEraTint: shared.uEraTint,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
      uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) },
      uSprite: { value: whitePixel() },
      uHasSprite: { value: 0 },
    };
    const dustMat = new THREE.ShaderMaterial({
      vertexShader: coreDustVertex,
      fragmentShader: coreDustFragment,
      defines: {
        ...sharedDefines,
        DUST_H: DUST_HEIGHT.toFixed(1),
        DUST_HALF_H: (DUST_HEIGHT / 2).toFixed(1),
        DUST_FADE_IN: (DUST_HEIGHT / 2 - DUST_HEIGHT * 0.15).toFixed(1),
        DUST_GAIN: (0.85).toFixed(2),
      },
      uniforms: dustU,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    dust.renderOrder = 2;            // with the fireflies, after the beam
    dust.frustumCulled = false;
    scene.add(dust);
    meshes.push(dust);
    disposables.push(dustGeo, dustMat, dustU.uSprite.value);
  }

  /* off the critical path, and silent whether or not the plates exist */
  loadPlates(beamU, dustU, state);

  const scratchA = new THREE.Color();
  const scratchB = new THREE.Color();

  return {
    /* Four float writes and one colour copy — that is the entire per-frame
       CPU cost of the pillar. Nothing is allocated here, ever. */
    update(TIMELINE, frame, dt) {
      if (state.disposed) return;
      const step = Math.min(Math.max(dt || 0, 0), 0.05);
      shared.uTime.value += step * motionScale;

      let s = TIMELINE && Number.isFinite(TIMELINE.smooth) ? TIMELINE.smooth : 0;
      if (s < 0) s = 0;
      else if (s > SMOOTH_MAX) s = SMOOTH_MAX;
      shared.uBandY.value = SCALE_TOP - s * SCALE_SPAN;

      if (frame && frame.world) {
        const w = frame.world;
        if (w.eraTint) shared.uEraTint.value.copy(w.eraTint);
        if (Number.isFinite(w.fogNear)) shared.uFogNear.value = w.fogNear;
        if (Number.isFinite(w.fogFar)) shared.uFogFar.value = w.fogFar;
      }
    },

    /* Any number of era tints (Color, hex or CSS string) resampled onto the
       shaders' fixed six — the ledger's era count is data, not a contract.
       Same resampling js/mist.js uses, so the ink and the pillar can never
       disagree about what a given point in the life looks like. */
    setEraColors(colors) {
      if (state.disposed || !Array.isArray(colors) || !colors.length) return;
      const n = colors.length;
      for (let i = 0; i < eraColors.length; i += 1) {
        const u = n > 1 ? (i / (eraColors.length - 1)) * (n - 1) : 0;
        const a = Math.min(n - 1, Math.floor(u));
        const b = Math.min(n - 1, a + 1);
        try {
          scratchA.set(colors[a]);
          scratchB.set(colors[b]);
        } catch (err) {
          return;                  // a malformed entry leaves the palette be
        }
        eraColors[i].copy(scratchA).lerp(scratchB, u - a);
      }
    },

    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      for (let i = 0; i < meshes.length; i += 1) {
        if (meshes[i].parent) meshes[i].parent.remove(meshes[i]);
      }
      for (let i = 0; i < disposables.length; i += 1) {
        if (disposables[i] && typeof disposables[i].dispose === 'function') {
          disposables[i].dispose();
        }
      }
      for (let i = 0; i < state.plates.length; i += 1) {
        state.plates[i].dispose();
      }
      state.plates.length = 0;
    },
  };
}
