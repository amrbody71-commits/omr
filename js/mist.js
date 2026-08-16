/* mist.js — THE SPINE MIST: volumetric ink erupting off the Thread of
   Light, wrapping the cards, coloured by the era it was born into.

   The reference reel has dense photographic ink-clouds boiling around the
   floating cards with a bright structure running down the middle. Ours has
   the same energy in this project's palette, and it takes its colour from
   the LIFE — a particle born at 2008 carries 2008's amber for its whole
   six seconds, wherever it drifts to.

   ── HOW IT WORKS ─────────────────────────────────────────────────────
   A GPUComputationRenderer pair of FBOs (position + velocity) advects up
   to 36 864 particles entirely on the GPU. The CPU writes eleven floats a
   frame and nothing else — no per-particle work, ever, exactly like
   js/particles.js. Everything else lives in js/shaders/mist.glsl.js, whose
   header carries the coherence proof for the two sim shaders.

     BIRTH      on the Thread's own helix (helixAt, pulled to THREAD_RADIUS),
                74% inside a band that RIDES the current progress — the
                eruption travels with you — and 26% over the whole spiral
                so its far reaches are never bare.
     MOTION     an outward radial impulse that carries ink from the spine
                (11.4) to the card ring (14.0) and no further before drag
                takes it, then divergence-free curl noise, a slow rise past
                the descending camera, and exponential drag. 6–9s lives.
     COLOUR     the era of the particle's BIRTH HEIGHT, over-saturated and
                lifted so the U6 bloom (threshold 0.72) catches the dense
                cores while thin haze stays haze. That is the "exploding
                colours": density decides what blooms.

   ── COST, HELD CONSTANT ACROSS TIERS ─────────────────────────────────
   Sprite diameter carries sqrt(REF_COUNT / count), so a base tier's 4 096
   big sprites and a high tier's 36 864 fine ones cover the SAME screen
   area and accumulate the SAME density. Only the grain changes — the fill
   cost, which is what actually decides the frame rate for an additive
   cloud, does not. Budget: ~6× overdraw of a one-fetch fragment shader.

   ── TEXTURES ─────────────────────────────────────────────────────────
   The plume sprites are optional. One silent HEAD probe decides whether
   assets/textures/ has been filled in yet (the house pattern, see
   js/textures.js); if it has not, the atlas keeps the procedurally drawn
   plumes it was born with and NOTHING is logged. If it has, each PNG is
   probed and painted over its cell as it arrives — the field upgrades in
   place, mid-flight, without a reload.

   Parented INSIDE spiralGroup, so the world rig spins and raises the mist
   with the cards for free (js/thread.js has the same deal). */

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { helixAt, TURNS, HEIGHT } from './spiral.js';
import { THREAD_RADIUS } from './thread.js';
import {
  mistPositionShader, mistVelocityShader, mistVertex, mistFragment,
} from './shaders/mist.glsl.js';

const TWO_PI = Math.PI * 2;

/* Simulation grid per tier. 64² = 4 096 · 128² = 16 384 · 192² = 36 864. */
const SIM_SIZE = { base: 64, mid: 128, high: 192 };
const DEFAULT_SIM = 128;

/* The count the art direction was tuned at; sprite size scales off it. */
const REF_COUNT = 128 * 128;

/* The two master dials. GAIN is per-particle peak brightness before the
   intensity chain — at ~5× overdraw the dense cores land just past the
   bloom threshold and thin haze sits around 0.2. SIZE_ART scales the whole
   field's sprite diameter.

   THE FILL BUDGET, since it is what actually decides the frame rate here.
   Mean sprite diameter is SIZE_MIN + SIZE_VAR/(SIZE_SKEW+1) = 0.50 world
   units, × the intensity and age factors ≈ 0.70, × SIZE_ART. gl_PointSize
   works out as uSizeK·d/depth with uSizeK ≈ 1900 at fov 46 and a 1620-px
   drawing buffer, so a mid-depth sprite covers ~56 px. Weighted over the
   depth spread of a 30-unit helix seen from 26 units out, 16 384 sprites
   come to roughly 5× overdraw of a ONE-FETCH fragment shader, of which
   the ~45% above the discard threshold actually blends. SIZE_ART trims
   that with margin; the governor's setDensity is the reserve below it.

   GAIN is set for the DELIVERED plume photographs, which are far denser
   than the procedural stand-ins — a core texel lands around 0.35 and a
   body texel around 0.09, so five overlapping sprites push the knots past
   the 0.72 bloom threshold while the haze between them stays haze. These
   two numbers are the right place to tune the look on screen.

   TUNED ON SCREEN against the reference stills: the first pass at 0.30 /
   0.85 buried the photographs in a uniform pink grain. Fewer-reading,
   larger, dimmer sprites give distinct plumes with real black between
   them — which is what the reference actually has — while CALM (below)
   thins the resident field so the ink reads as weather around the
   photographs rather than a wall in front of them. */
const MIST_GAIN = 0.085;
const SIZE_ART = 1.72;

/* Resting density. setIntensity(1) means "normal", not "maximum": the
   ambient field sits here and only an era eruption spends the headroom. */
const CALM = 0.26;

/* pulse() decay: half-life ~0.35s, spent in about 1.5s — an era boundary
   erupts and settles inside one card's worth of scrolling. */
const SURGE_DECAY = 2.0;
const SURGE_MAX = 1.8;

const INTENSITY_LAMBDA = 3;   // setIntensity easing, dt-correct
const VEL_LAMBDA = 8;         // matches spiral.js's own velocity smoothing

/* The shipped palette (data/memories.json), used until — and only until —
   the orchestrator calls setEraColors with the ledger's own tints. Frame
   one is already right; it never waits to be told. */
const DEFAULT_ERAS = [
  '#FFD9A0', '#FFB865', '#E98FA0', '#B08CC4', '#7FB8B0', '#F4EFE6',
];

/* ------------------------------------------------------------------ */
/* sprite atlas                                                        */
/* ------------------------------------------------------------------ */

const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
const CELL_PX = 256;                 // → a 1024 × 512 atlas
const SPRITE_DIR = 'assets/textures/';

/* Cell order. Cells 0–6 are replaced by these files if they exist; cell 7
   is always procedural, so the field can never be uniform. */
const SPRITE_FILES = [
  'ink-plume-a.png', 'ink-plume-b.png', 'ink-plume-c.png',
  'smoke-wisp-a.png', 'smoke-wisp-b.png', 'dust-motes.png', 'spark-point.png',
];

/* The procedural stand-ins, one species per cell, ordered to MATCH the
   filenames above — so a half-delivered batch still reads as one coherent
   set. A single radial gradient would be the cartoon blob we are trying
   not to be; each of these is a cluster of dozens of soft overlapping
   lobes under an anisotropic envelope, which is how a real plume's
   silhouette actually behaves. */
const SPECIES = [
  { n: 62, spread: 0.30, rMin: 0.070, rMax: 0.27, a: 0.085, aniso: 1.30, ang: 0.35, core: 0.55 },
  { n: 54, spread: 0.33, rMin: 0.060, rMax: 0.30, a: 0.080, aniso: 1.15, ang: 1.90, core: 0.40 },
  { n: 70, spread: 0.28, rMin: 0.050, rMax: 0.24, a: 0.090, aniso: 1.45, ang: 2.60, core: 0.62 },
  { n: 34, spread: 0.36, rMin: 0.050, rMax: 0.17, a: 0.055, aniso: 2.40, ang: 0.75, core: 0.18 },
  { n: 30, spread: 0.38, rMin: 0.040, rMax: 0.15, a: 0.050, aniso: 2.80, ang: 2.20, core: 0.14 },
  { n: 96, spread: 0.40, rMin: 0.012, rMax: 0.05, a: 0.300, aniso: 1.00, ang: 0.00, core: 0.10 },
  { n: 10, spread: 0.10, rMin: 0.030, rMax: 0.11, a: 0.220, aniso: 1.00, ang: 0.00, core: 1.00 },
  { n: 58, spread: 0.31, rMin: 0.060, rMax: 0.26, a: 0.082, aniso: 1.20, ang: 1.20, core: 0.45 },
];

/* mulberry32 — the atlas is identical on every reload, so nobody ever
   chases a "the mist looked different that time" ghost. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintSpecies(ctx, sp, rand) {
  const S = CELL_PX;
  const c = S * 0.5;
  ctx.clearRect(0, 0, S, S);

  /* 'lighter' accumulates alpha as well as colour, so the finished cell is
     white at alpha = Σ contributions — compositing that onto black gives
     exactly the greyscale intensity the shader wants. */
  ctx.globalCompositeOperation = 'lighter';
  const ca = Math.cos(sp.ang);
  const sa = Math.sin(sp.ang);
  for (let i = 0; i < sp.n; i += 1) {
    /* triangular ≈ gaussian: two uniforms, no Box–Muller, no tails to clip */
    const u = (rand() + rand() - 1) * sp.aniso;
    const v = (rand() + rand() - 1) / sp.aniso;
    const x = c + (u * ca - v * sa) * S * sp.spread;
    const y = c + (u * sa + v * ca) * S * sp.spread;
    const r = (sp.rMin + (sp.rMax - sp.rMin) * Math.pow(rand(), 1.7)) * S;
    const a = sp.a * (0.45 + 0.55 * rand());
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(4) + ')');
    g.addColorStop(0.45, 'rgba(255,255,255,' + (a * 0.42).toFixed(4) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /* a centre of mass, so the sprite has somewhere to be brightest */
  if (sp.core > 0) {
    const r = S * 0.16;
    const g = ctx.createRadialGradient(c, c, 0, c, c, r);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.32 * sp.core).toFixed(4) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(c - r, c - r, r * 2, r * 2);
  }

  /* Kill the rim: destination-in multiplies what is there by this alpha,
     so the cell reaches exactly zero before its edge and can never seam. */
  ctx.globalCompositeOperation = 'destination-in';
  const env = ctx.createRadialGradient(c, c, 0, c, c, S * 0.5);
  env.addColorStop(0, 'rgba(255,255,255,1)');
  env.addColorStop(0.62, 'rgba(255,255,255,1)');
  env.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

/* Builds the atlas canvas with all eight procedural species already drawn,
   then (silently, off the critical path) tries to upgrade cells 0–6 to the
   real plume PNGs. Returns { texture, cancel }. */
function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * CELL_PX;
  canvas.height = ATLAS_ROWS * CELL_PX;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const scratch = document.createElement('canvas');
  scratch.width = CELL_PX;
  scratch.height = CELL_PX;
  const sctx = scratch.getContext('2d');

  for (let i = 0; i < SPECIES.length; i += 1) {
    paintSpecies(sctx, SPECIES[i], rng(0x9E3779B9 + i * 2654435761));
    ctx.drawImage(scratch, (i % ATLAS_COLS) * CELL_PX,
      Math.floor(i / ATLAS_COLS) * CELL_PX);
  }

  const texture = new THREE.CanvasTexture(canvas);
  /* Intensity DATA, not colour: no sRGB decode, the shader shapes it. */
  texture.colorSpace = THREE.NoColorSpace;
  /* Atlas row 0 must be canvas row 0 — the shader indexes cells from the
     top left, and three flips canvas sources by default. */
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  /* Mipmapped: distant motes minify hard, and the fragment shader's round
     envelope is applied AFTER the fetch, so cross-cell bleed at the small
     mips can never show as a square edge. */
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  let cancelled = false;

  function paintCell(index, bitmap) {
    if (cancelled) return;
    const x = (index % ATLAS_COLS) * CELL_PX;
    const y = Math.floor(index / ATLAS_COLS) * CELL_PX;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, CELL_PX, CELL_PX);
    /* The plumes are delivered at 1024²; a 4:1 downscale at the default
       'low' smoothing aliases their fine curl detail into sparkle. A 256px
       cell is already oversampled for a sprite that never exceeds 150px on
       screen, so the only thing that matters here is filtering it well. */
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, x, y, CELL_PX, CELL_PX);
    if (typeof bitmap.close === 'function') bitmap.close();
    texture.needsUpdate = true;
  }

  /* One silent HEAD per asset, 404 is normal and not an error — the same
     contract js/textures.js uses for the photographs. */
  async function exists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok;
    } catch (err) {
      return false;
    }
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

  async function upgrade() {
    if (typeof createImageBitmap !== 'function') return;
    /* Probe ONE file first. The plumes are generated as a batch, so a miss
       here means the whole batch is absent — and stopping now caps the
       browser's own network chatter at a single line instead of seven. */
    if (!await exists(SPRITE_DIR + SPRITE_FILES[0])) return;
    await Promise.all(SPRITE_FILES.map(async (name, i) => {
      if (cancelled) return;
      const url = SPRITE_DIR + name;
      if (i > 0 && !await exists(url)) return;   // a partial batch still works
      const bmp = await grab(url);
      if (bmp) paintCell(i, bmp);
    }));
  }

  upgrade();

  return {
    texture,
    cancel() { cancelled = true; },
  };
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/* An inert stand-in with the exact same shape, returned when the GPGPU
   path is unavailable. The site loses the mist and notices nothing else —
   and says nothing about it. */
function inertMist() {
  return {
    update() {},
    setIntensity() {},
    pulse() {},
    setEraColors() {},
    setDensity() {},
    dispose() {},
    count: 0,
  };
}

/* initMist(scene, spiralGroup, quality, { renderer })
     → { update(TIMELINE, frame, dt), setIntensity(v), pulse(strength),
         setEraColors(colors), setDensity(f), dispose(), count }

   NEVER throws. app.js awaits start() on the boot path, so a mist that
   cannot build must degrade to nothing rather than take the site with it —
   an atmosphere layer is not worth a black screen. Every failure lands on
   the inert stand-in, silently, with the same shape the caller expects.

   `scene` is accepted for symmetry with initParticles and is deliberately
   unused: the mist belongs to the spiral, not the world. */
export function initMist(scene, spiralGroup, quality, options = {}) {
  try {
    return buildMist(scene, spiralGroup, quality, options) || inertMist();
  } catch (err) {
    return inertMist();
  }
}

function buildMist(scene, spiralGroup, quality, { renderer } = {}) {
  if (!spiralGroup || !renderer) return inertMist();

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* Reduced motion freezes ADVECTION only. The field is seeded already
     billowed (see below), so what holds still is a real cloud, not a line
     of unspent particles — and its colour keeps living with the eras. */
  const motionScale = reduced ? 0 : 1;
  /* Velocity smear is clamped to 20% rather than killed, matching the
     convention spiral.js uses for every velocity-driven effect. */
  const smearScale = reduced ? 0.2 : 1;

  const size = SIM_SIZE[(quality && quality.name)] || DEFAULT_SIM;
  const count = size * size;

  /* ---- the GPGPU pair ------------------------------------------------ */
  /* Half-float would quantise a 30-unit helix at ~0.03 units, which is the
     same order as a slow particle's per-frame step — mist would visibly
     stair-step. Full float when the platform has it, half only as a last
     resort before going inert. */
  const dataType = renderer.extensions.has('EXT_color_buffer_float')
    ? THREE.FloatType : THREE.HalfFloatType;

  const gpu = new GPUComputationRenderer(size, size, renderer);
  if (typeof gpu.setDataType === 'function') gpu.setDataType(dataType);

  const dtPos = gpu.createTexture();
  const dtVel = gpu.createTexture();
  seedField(dtPos.image.data, dtVel.image.data, count);

  const velVar = gpu.addVariable('textureVelocity', mistVelocityShader, dtVel);
  const posVar = gpu.addVariable('texturePosition', mistPositionShader, dtPos);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);

  /* Geometry constants reach the shaders as defines, read from spiral.js
     and thread.js — helixAt stays the single source of truth. */
  const geomDefines = {
    SPINE_R: THREAD_RADIUS.toFixed(4),
    TURNS: TURNS.toFixed(4),
    HELIX_H: HEIGHT.toFixed(1),
  };
  Object.assign(velVar.material.defines, geomDefines);
  Object.assign(posVar.material.defines, geomDefines);

  /* One uniform object per name, shared BY REFERENCE between both sim
     shaders — one write per frame reaches the whole simulation, and the
     two shaders can never disagree about the clock (the coherence rule in
     js/shaders/mist.glsl.js depends on exactly this). */
  const simU = {
    uDelta: { value: 0 },
    uTime: { value: 3.17 },      // non-zero: a frozen field still has variety
    uMotion: { value: motionScale },
    uSurge: { value: 0 },
    uProgress: { value: 0 },
    uIntensity: { value: 1 },
  };
  velVar.material.uniforms.uDelta = simU.uDelta;
  velVar.material.uniforms.uTime = simU.uTime;
  velVar.material.uniforms.uMotion = simU.uMotion;
  velVar.material.uniforms.uSurge = simU.uSurge;
  velVar.material.uniforms.uProgress = simU.uProgress;
  velVar.material.uniforms.uIntensity = simU.uIntensity;
  posVar.material.uniforms.uDelta = simU.uDelta;
  posVar.material.uniforms.uTime = simU.uTime;
  posVar.material.uniforms.uMotion = simU.uMotion;
  posVar.material.uniforms.uSurge = simU.uSurge;
  posVar.material.uniforms.uProgress = simU.uProgress;

  if (gpu.init() !== null) {
    if (typeof gpu.dispose === 'function') gpu.dispose();
    return inertMist();
  }

  /* ---- the draw ------------------------------------------------------ */
  const atlas = buildAtlas();

  /* `position` carries the particle's texel reference — there is no
     CPU-side position to store, so the buffer earns its bytes twice. */
  const refs = new Float32Array(count * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      refs[i * 3] = (x + 0.5) / size;
      refs[i * 3 + 1] = (y + 0.5) / size;
      refs[i * 3 + 2] = 0;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(refs, 3));

  const eraColors = DEFAULT_ERAS.map((hex) => new THREE.Color(hex));

  const drawU = {
    uPos: { value: null },
    uVel: { value: null },
    /* framebuffer px per world unit at unit depth; onBeforeRender keeps it
       honest against the live fov and drawing-buffer height */
    uSizeK: { value: 900 },
    uSizeScale: { value: SIZE_ART * Math.sqrt(REF_COUNT / count) },
    uIntensity: { value: 1 },
    uSurge: { value: 0 },
    uGain: { value: MIST_GAIN },
    uSpin: { value: 0 },
    uRise: { value: 0 },
    uLead: { value: 0.012 },
    uEraColors: { value: eraColors },
    uAmbientTint: { value: new THREE.Color('#F4EFE6') },
    uSprite: { value: atlas.texture },
  };

  /* Bound from frame one, so the samplers are NEVER unbound even if the
     first render lands before the first update (spiral.js keeps the card
     textures on the same discipline). */
  drawU.uPos.value = gpu.getCurrentRenderTarget(posVar).texture;
  drawU.uVel.value = gpu.getCurrentRenderTarget(velVar).texture;

  const material = new THREE.ShaderMaterial({
    vertexShader: mistVertex,
    fragmentShader: mistFragment,
    uniforms: drawU,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    /* depth TEST stays on: mist behind a card is correctly hidden and only
       adds light in front, which is the whole reason it reads as volume
       wrapping the photographs rather than a decal over them. */
    depthTest: true,
    fog: false,          // the shader carries its own near and far manners
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = 3;          // after cards (0), thread (1), fireflies (2)
  points.frustumCulled = false;    // the positions live in a texture
  spiralGroup.add(points);

  /* gl_PointSize is in FRAMEBUFFER pixels, so the drawing-buffer height
     (which already carries the device pixel ratio) is the right scale, and
     projectionMatrix[1][1] is 1/tan(fov/2) — the era ledger breathes the
     fov every frame and this follows it for free. */
  const bufferSize = new THREE.Vector2();
  points.onBeforeRender = (rend, sc, cam) => {
    rend.getDrawingBufferSize(bufferSize);
    drawU.uSizeK.value = 0.5 * bufferSize.y * cam.projectionMatrix.elements[5];
  };

  /* ---- per-frame state ----------------------------------------------- */
  let intensity = CALM;
  let intensityTarget = CALM;
  let surge = 0;
  let prevSpin = 0;
  let spinSmooth = 0;
  let riseSmooth = 0;
  let disposed = false;

  const scratchA = new THREE.Color();
  const scratchB = new THREE.Color();

  const api = {
    /* Eleven float writes and one compute() — that is the entire CPU cost
       of up to 36 864 particles. */
    update(TIMELINE, frame, dt) {
      if (disposed) return;
      const step = Math.min(Math.max(dt || 0, 0), 0.05);

      intensity += (intensityTarget - intensity)
        * (1 - Math.exp(-INTENSITY_LAMBDA * step));
      surge *= Math.exp(-SURGE_DECAY * step);
      if (surge < 1e-3) surge = 0;

      /* The world rig's own velocity, rebuilt exactly as spiral.js builds
         it: the scroll descent spins the helix at velocity·TURNS·2π and the
         drag adds d(spinOffset)/dt, so a DRAG smears the mist precisely as
         a scroll does. Smoothed on the same time constant, so the two
         effects can never disagree about how fast the world is moving. */
      if (TIMELINE && step > 0) {
        const spinVel = (TIMELINE.spinOffset - prevSpin) / step;
        const spinTarget = -(TIMELINE.velocity * TURNS * TWO_PI + spinVel);
        const riseTarget = TIMELINE.velocity * HEIGHT;
        const k = 1 - Math.exp(-VEL_LAMBDA * step);
        spinSmooth += (spinTarget - spinSmooth) * k;
        riseSmooth += (riseTarget - riseSmooth) * k;
      }
      if (TIMELINE) prevSpin = TIMELINE.spinOffset;

      simU.uDelta.value = step;
      simU.uTime.value += step * motionScale;
      simU.uSurge.value = surge;
      simU.uIntensity.value = intensity;
      if (TIMELINE) simU.uProgress.value = TIMELINE.smooth;

      /* Reduced motion skips the compute entirely: the freeze is then a
         fact about the frame loop, not a number the shader has to honour. */
      if (motionScale > 0) gpu.compute();

      drawU.uPos.value = gpu.getCurrentRenderTarget(posVar).texture;
      drawU.uVel.value = gpu.getCurrentRenderTarget(velVar).texture;
      drawU.uIntensity.value = intensity;
      drawU.uSurge.value = surge;
      drawU.uSpin.value = spinSmooth * smearScale;
      drawU.uRise.value = riseSmooth * smearScale;

      /* The ambient breath of the era you are IN, over the era each
         particle was born into (js/eras.js writes the interpolated tint). */
      if (frame && frame.world && frame.world.eraTint) {
        drawU.uAmbientTint.value.copy(frame.world.eraTint);
      }
    },

    /* 0..1 density dial: eased, so an era transition can ramp eruptions up
       and the middle of an era can calm them without a visible step. */
    setIntensity(v) {
      const n = Number(v);
      const norm = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
      intensityTarget = norm * CALM;   // 1 = the tuned resting density
    },

    /* A one-shot surge. It ages the whole field, so a wave of deaths
       becomes a wave of BIRTHS with a harder impulse behind it — an
       eruption, not just a brightness bump. Strengths stack, capped. */
    pulse(strength) {
      const n = Number(strength);
      if (!Number.isFinite(n) || n <= 0) return;
      surge = Math.min(SURGE_MAX, surge + n);
    },

    /* Any number of era tints (Color, hex or CSS string) resampled onto the
       shader's fixed six — the ledger's era count is data, not a contract. */
    setEraColors(colors) {
      if (!Array.isArray(colors) || !colors.length) return;
      const n = colors.length;
      for (let i = 0; i < eraColors.length; i += 1) {
        const u = n > 1 ? (i / (eraColors.length - 1)) * (n - 1) : 0;
        const a = Math.min(n - 1, Math.floor(u));
        const b = Math.min(n - 1, a + 1);
        try {
          scratchA.set(colors[a]);
          scratchB.set(colors[b]);
        } catch (err) {
          return;                    // a malformed entry leaves the palette be
        }
        eraColors[i].copy(scratchA).lerp(scratchB, u - a);
      }
    },

    /* The U7 governor's thinning hook, same shape as particles.setDensity:
       texel order carries no spatial meaning, so drawing the first ⌊n·f⌋
       references IS a uniform random subset of the cloud. */
    setDensity(fraction) {
      const f = Math.min(1, Math.max(0, Number(fraction) || 0));
      const kept = Math.floor(count * f);
      geometry.setDrawRange(0, kept);
      api.count = kept;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      atlas.cancel();
      if (points.parent) points.parent.remove(points);
      points.onBeforeRender = () => {};
      geometry.dispose();
      material.dispose();
      atlas.texture.dispose();
      if (typeof gpu.dispose === 'function') gpu.dispose();
      api.count = 0;
    },

    count,
  };

  return api;
}

/* ------------------------------------------------------------------ */
/* seeding                                                             */
/* ------------------------------------------------------------------ */

/* Frame one must already be a CLOUD. Seeding every particle on the spine
   with age 0 would open on a bright wire that blows apart over six
   seconds — and under reduced motion, where nothing ever respawns, it
   would stay a wire forever. So the field is born mid-life: ages spread
   over [0,1), and each particle displaced roughly where its own history
   would have carried it. The sim smooths the approximation away within a
   second; reduced motion simply keeps the still it was handed.

   Birth heights are UNIFORM over the helix here, not weighted toward the
   opening progress — the travelling band establishes itself within one
   lifetime anyway, and a uniform seed is the only one that also looks
   right at every point of a frozen journey. */
function seedField(pos, vel, count) {
  /* Matches the shader's own arithmetic: BIRTH_SPEED/DRAG of outward reach,
     LIFT/DRAG of rise, and a curl random-walk that wanders rather than
     travels. See the REACH note in js/shaders/mist.glsl.js. */
  const REACH = 3.4 / 1.15;
  const DRAG = 1.15;
  const LIFE = 7.5;
  const RISE = (0.75 / 1.15) * 0.65;
  const WANDER = 1.4 * 0.42;
  const JIT = 0.42;              // BIRTH_JIT: the sleeve around the filament

  /* triangular ≈ gaussian, in [-1,1] */
  const g = () => Math.random() + Math.random() - 1;

  for (let i = 0; i < count; i += 1) {
    const t = Math.random();
    const { angle, y } = helixAt(t);
    const nx = Math.sin(angle);
    const nz = Math.cos(angle);
    const sx = nx * THREAD_RADIUS;
    const sz = nz * THREAD_RADIUS;

    const age = Math.random();
    const secs = age * LIFE;
    const out = REACH * (1 - Math.exp(-secs * DRAG))
      * (Math.random() < 0.22 ? -0.45 : 1);
    const walk = WANDER * secs + JIT;

    pos[i * 4] = sx + nx * out + g() * walk;
    pos[i * 4 + 1] = y + RISE * secs + g() * walk;
    pos[i * 4 + 2] = sz + nz * out + g() * walk;
    pos[i * 4 + 3] = age;                 // normalised age, the sim owns life

    /* A plausible drift; the velocity shader corrects it inside one frame. */
    const s = 1.4 * (1 - age) + 0.25;
    vel[i * 4] = nx * out * 0.25 + g() * s;
    vel[i * 4 + 1] = 0.4 + g() * s;
    vel[i * 4 + 2] = nz * out * 0.25 + g() * s;
    vel[i * 4 + 3] = t;                   // birth height — this IS the colour
  }
}
