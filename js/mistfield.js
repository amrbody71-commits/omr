/* mistfield.js — THE INK FIELD: the mist, rebuilt the way the reference
   site actually does it (the A/B alternative to js/mist.js — the
   orchestrator switches between them with ?mist=v2; the two never run
   together and share nothing).

   The reference's clouds are STATIC, solid, photographic ink shapes that
   only ever move because the world rotates around them. So: ~28 large
   billboards (tier-scaled 14/24/32), each carrying ONE full-resolution
   plume or wisp photograph, placed once in spiralGroup-local space and
   never moved again. The scroll's rotation and rise sweep the arrangement
   past the camera; near wisps parallax against the far field; that IS the
   motion story. Substance quality comes from texture resolution instead
   of particle count, which is why five draw calls can out-read 16 384
   additive sprites.

   ── PLACEMENT ("the ink field") ──────────────────────────────────────
   OUTER FIELD — radii RADIUS+3 … RADIUS+20 (17–34: outside the 14-unit
   card ring; environment, not foreground), golden-angle azimuths with
   jitter, shuffled-stratified radii and heights over the helix span ±6
   (y ∈ [−36, +6]). Shuffling the strata breaks any angle↔radius↔height
   correlation — no accidental spiral of clouds. Sizes 5–16 world units,
   biggest furthest out, so apparent size stays calm while true parallax
   stays big.
   NEAR WISPS — 4–8 small (3–5 unit) wisps at radius 8–12, each tucked in
   the vertical gap BETWEEN helix windings: anchored half a pitch
   (HEIGHT/TURNS/2 = 6 units) above or below the helix point at its own
   azimuth, via helixAt — the single source of truth for the curve. They
   slide past the camera closer than the card ring's far side, which is
   what sells depth when the world turns.

   ── PERMITTED LIFE (barely perceptible, frozen under reduced motion) ─
   Opacity breathing ±6% over 20–40s, phase-hashed per billboard; a
   bounded UV sway (rate ≤ 0.02 rad/s) on half of them; and a velocity-
   driven vertical UV shear (≤ ±0.04) on the near wisps only. The
   ARRANGEMENT never moves — pulse() swells and brightens billboards near
   the focus height and decays in ~1.2s, anchors untouched.

   ── SORTING, DECIDED ONCE (the tradeoff, stated) ─────────────────────
   depthTest on, depthWrite off, and back-to-front order assigned at
   build: instances inside each draw sorted by radius-from-axis
   DESCENDING, and the five draws sequenced far-species → near-species by
   mean radius. The group only ever rotates about Y, so what changes with
   scroll is which azimuth faces the camera — and for billboards that
   OVERLAP on screen (angularly close), larger radius almost always means
   deeper, on either side of the axis. The ordering is wrong only for
   cross-axis pairs (≥ ~30 units of depth apart, far one heavily
   depth-faded) and for same-azimuth pairs exactly while they sweep the
   camera's own side, where the near fade has already gutted the body
   term. A per-frame sort would buy back a fraction of a percent of
   frames and cost a CPU pass over the field every frame; the premultiplied
   body alpha tops out ~0.6, so the worst mis-order reads as a slightly
   bright overlap, never a pop.

   ── TEXTURES ─────────────────────────────────────────────────────────
   Five 1024² white-on-black photographs (assets/textures/, floor crushed
   to 0). ONE silent HEAD probe decides whether the batch exists; absent
   or failing, each unit keeps the procedural soft-blob canvas it was born
   with and NOTHING is logged. Present, each PNG paints over its canvas as
   it arrives — the field upgrades in place, mid-flight.

   Parented INSIDE spiralGroup — rotation of the world is the motion. */

import * as THREE from 'three';
import { helixAt, TURNS, HEIGHT, RADIUS } from './spiral.js';
import {
  mistFieldVertex, mistFieldFragment,
} from './shaders/mistfield.glsl.js';

const TWO_PI = Math.PI * 2;
const GOLDEN = 2.399963229728653;   // golden angle, rad

/* Billboard counts per tier: outer environment field + near wisps.
   base 10+4=14 · mid 17+7=24 · high 24+8=32. */
const COUNTS = {
  base: { outer: 10, inner: 4 },
  mid: { outer: 17, inner: 7 },
  high: { outer: 24, inner: 8 },
};
const DEFAULT_COUNT = COUNTS.mid;

/* ---- placement ------------------------------------------------------ */
const R_MIN = RADIUS + 3;          // 17 — safely outside the card ring
const R_MAX = RADIUS + 20;         // 34
const Y_PAD = 6;                   // heights span the helix ±6
const SIZE_MIN = 5;                // world units, smallest outer billboard
const SIZE_MAX = 16;               // biggest, furthest out
const WISP_R_MIN = RADIUS - 6;     // 8
const WISP_R_SPAN = 4;             // …to 12
const WISP_SIZE_MIN = 3;
const WISP_SIZE_SPAN = 2;          // …to 5
const HALF_PITCH = HEIGHT / TURNS / 2;   // 6 — the gap between windings

/* ---- response dials -------------------------------------------------- */
const INTENSITY_LAMBDA = 3;   // setIntensity easing, dt-correct (as mist.js)
const VEL_LAMBDA = 8;         // rig-velocity smoothing (as spiral.js)
const PULSE_DECAY = 3.2;      // e^(−3.2·1.2s) ≈ 0.02 — spent in ~1.2s
const PULSE_MAX = 1.5;        // stacked era boundaries cap here

/* ---- permitted-life ranges (consumed by the vertex shader) ---------- */
const BREATH_PERIOD_MIN = 20;   // seconds
const BREATH_PERIOD_VAR = 20;   // …to 40
const ROLL_AMP_MIN = 0.020;     // rad — sway amplitude (half the field)
const ROLL_AMP_VAR = 0.015;
const ROLL_FREQ_MIN = 0.15;     // rad/s — amp·freq ≤ 0.016 < 0.02 cap
const ROLL_FREQ_VAR = 0.30;
const SHEAR_GAIN = 0.05;        // near wisps; shader hard-caps at ±0.04

/* The shipped palette, used until the orchestrator calls setEraColors
   with the ledger's own tints — frame one is already right. */
const DEFAULT_ERAS = [
  '#FFD9A0', '#FFB865', '#E98FA0', '#B08CC4', '#7FB8B0', '#F4EFE6',
];

/* ------------------------------------------------------------------ */
/* textures: five units, procedural-born, photo-upgraded              */
/* ------------------------------------------------------------------ */

const TEX_DIR = 'assets/textures/';
const FALLBACK_PX = 512;

/* One species per texture per draw call. `body` scales the weight term:
   the wisps are haze, not mass. `kind` picks the fallback painter. */
const SPECIES = [
  { file: 'ink-plume-a.png', kind: 'burst', body: 1.0 },
  { file: 'ink-plume-b.png', kind: 'rays', body: 0.9 },
  { file: 'ink-plume-c.png', kind: 'column', body: 1.0 },
  { file: 'smoke-wisp-a.png', kind: 'wisp', body: 0.55 },
  { file: 'smoke-wisp-b.png', kind: 'ribbon', body: 0.55 },
];

/* Outer-field species cycle: deterministic and balanced at every tier —
   dense plumes carry the field, wisps appear sparsely as distant haze. */
const CYCLE = [0, 2, 1, 0, 2, 4, 1, 0, 2, 3];

/* mulberry32 — the field is identical on every reload (the same contract
   the mist atlas keeps: nobody chases a "it looked different" ghost). */
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

function lobe(ctx, S, x, y, r, a) {
  const g = ctx.createRadialGradient(x * S, y * S, 0, x * S, y * S, r * S);
  g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(4) + ')');
  g.addColorStop(0.5, 'rgba(255,255,255,' + (a * 0.4).toFixed(4) + ')');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect((x - r) * S, (y - r) * S, r * 2 * S, r * 2 * S);
}

/* The stand-ins are soft-lobe composites shaped per species — a burst, a
   ray fan, a rising column, an S-wisp, crossing ribbons — so even without
   the photographs the field demos its variety, not a page of one blob. */
function paintFallback(ctx, S, kind, rand) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  const tri = () => rand() + rand() - 1;    // triangular ≈ gaussian

  if (kind === 'burst') {
    for (let i = 0; i < 70; i += 1) {
      lobe(ctx, S, 0.5 + tri() * 0.26, 0.48 + tri() * 0.28,
        0.05 + 0.17 * Math.pow(rand(), 1.6), 0.085 * (0.5 + 0.7 * rand()));
    }
    lobe(ctx, S, 0.5, 0.56, 0.20, 0.16);
  } else if (kind === 'rays') {
    for (let ray = 0; ray < 24; ray += 1) {
      const ang = rand() * TWO_PI;
      const len = 0.26 + 0.20 * rand();
      for (let s = 0; s < 9; s += 1) {
        const d = ((s + 1) / 9) * len;
        lobe(ctx, S, 0.5 + Math.cos(ang) * d, 0.5 + Math.sin(ang) * d,
          0.012 + 0.020 * (1 - s / 9) + 0.010 * rand(),
          0.16 * (1 - 0.7 * (s / 9)));
      }
    }
    lobe(ctx, S, 0.5, 0.5, 0.13, 0.30);
  } else if (kind === 'column') {
    const ph = rand() * TWO_PI;
    for (let i = 0; i < 64; i += 1) {
      const t = i / 63;
      const sway = 0.10 * Math.sin(t * 4.4 + ph)
                 + 0.05 * Math.sin(t * 9.1 + ph * 1.7);
      lobe(ctx, S, 0.5 + sway + tri() * 0.05, 0.92 - 0.84 * t,
        0.045 + 0.050 * t + 0.020 * rand(), 0.10 * (0.6 + 0.8 * rand()));
    }
  } else {
    const paths = kind === 'ribbon' ? 2 : 1;
    for (let p = 0; p < paths; p += 1) {
      const ph = rand() * TWO_PI;
      const y0 = 0.30 + 0.40 * rand();
      const amp = kind === 'ribbon' ? 0.18 : 0.24;
      for (let i = 0; i < 60; i += 1) {
        const t = i / 59;
        lobe(ctx, S, 0.12 + 0.76 * t,
          y0 + amp * Math.sin(t * 5.2 + ph) + tri() * 0.02,
          0.030 + 0.045 * rand(), 0.070 * (0.6 + 0.8 * rand()));
      }
    }
  }

  /* Kill the rim: the cell reaches exactly zero before its edge, so the
     shader's edge mask has nothing to fight even on the fallbacks. */
  ctx.globalCompositeOperation = 'destination-in';
  const env = ctx.createRadialGradient(S * 0.5, S * 0.5, 0, S * 0.5, S * 0.5, S * 0.5);
  env.addColorStop(0, 'rgba(255,255,255,1)');
  env.addColorStop(0.55, 'rgba(255,255,255,1)');
  env.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

/* Builds all five units procedurally, then (silently, off the critical
   path) tries to upgrade them to the delivered photographs. ONE HEAD
   probe on the first file gates the whole batch — the plumes are
   generated as a set, so one miss means all missing, and the browser's
   own network chatter stays capped at a single line. Never logs. */
function buildTextureUnits(renderer) {
  let anisotropy = 1;
  try {
    if (renderer && renderer.capabilities) {
      anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    }
  } catch (err) { /* cosmetic only */ }

  const units = SPECIES.map((sp, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = FALLBACK_PX;
    canvas.height = FALLBACK_PX;
    const ctx = canvas.getContext('2d');
    paintFallback(ctx, FALLBACK_PX, sp.kind, rng(0xB16B00B5 + i * 2654435761));

    const texture = new THREE.CanvasTexture(canvas);
    /* Intensity DATA, not colour — no sRGB decode; the shader shapes it.
       flipY stays default (true): plume bases painted at canvas bottom
       land at quad bottom, and the PNGs display exactly as authored. */
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = anisotropy;
    return { canvas, ctx, texture };
  });

  let cancelled = false;

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
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return;
    if (!await exists(TEX_DIR + SPECIES[0].file)) return;
    await Promise.all(SPECIES.map(async (sp, i) => {
      const bmp = await grab(TEX_DIR + sp.file);
      if (!bmp || cancelled) {
        if (bmp && typeof bmp.close === 'function') bmp.close();
        return;
      }
      const u = units[i];
      /* Full-resolution swap: resizing the canvas clears it, the photo is
         drawn 1:1, and needsUpdate re-uploads — an in-place upgrade with
         no material or geometry churn. */
      u.canvas.width = bmp.width;
      u.canvas.height = bmp.height;
      u.ctx.drawImage(bmp, 0, 0);
      if (typeof bmp.close === 'function') bmp.close();
      u.texture.needsUpdate = true;
    }));
  }

  upgrade();

  return {
    units,
    cancel() { cancelled = true; },
  };
}

/* ------------------------------------------------------------------ */
/* layout: the arrangement, decided once                               */
/* ------------------------------------------------------------------ */

function shuffledSlots(n, rand) {
  const s = new Array(n);
  for (let i = 0; i < n; i += 1) s[i] = i;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  return s;
}

/* Returns one instance-list per species. Every number here is decided at
   build and never touched again — the arrangement is the set. */
function buildLayout(counts) {
  const rand = rng(0x1AF1E1D5);
  const buckets = SPECIES.map(() => []);
  let parity = 0;   // roll on half the field, alternating globally

  function common(sp) {
    parity += 1;
    return {
      phase: rand() * TWO_PI,
      breathFreq: TWO_PI / (BREATH_PERIOD_MIN + BREATH_PERIOD_VAR * rand()),
      rollAmp: (parity % 2 === 0) ? ROLL_AMP_MIN + ROLL_AMP_VAR * rand() : 0,
      rollFreq: ROLL_FREQ_MIN + ROLL_FREQ_VAR * rand(),
      ampVar: 0.75 + 0.50 * rand(),
      hueJit: rand() * 2 - 1,
      bodyVar: (0.80 + 0.40 * rand()) * sp.body,
    };
  }

  /* ---- outer field --------------------------------------------------- */
  const n = counts.outer;
  const rSlot = shuffledSlots(n, rand);
  const ySlot = shuffledSlots(n, rand);
  for (let k = 0; k < n; k += 1) {
    const angle = k * GOLDEN + (rand() - 0.5) * 0.7;
    const r = R_MIN + (R_MAX - R_MIN) * ((rSlot[k] + 0.15 + 0.7 * rand()) / n);
    const y = -HEIGHT - Y_PAD
      + (HEIGHT + 2 * Y_PAD) * ((ySlot[k] + 0.15 + 0.7 * rand()) / n);
    /* Biggest furthest out: apparent size stays calm, parallax stays big. */
    const size = Math.min(SIZE_MAX, SIZE_MIN + (SIZE_MAX - SIZE_MIN)
      * Math.pow((r - R_MIN) / (R_MAX - R_MIN), 1.1) * (0.8 + 0.4 * rand()));
    const s = SPECIES[CYCLE[k % CYCLE.length]];
    buckets[CYCLE[k % CYCLE.length]].push({
      x: Math.sin(angle) * r,
      y,
      z: Math.cos(angle) * r,
      r,
      /* A build-time mirror on half: one photograph reads as many clouds. */
      sx: size * (0.94 + 0.12 * rand()) * (rand() < 0.5 ? -1 : 1),
      sy: size * (0.94 + 0.12 * rand()),
      shearGain: 0,
      ...common(s),
    });
  }

  /* ---- near wisps: tucked BETWEEN the helix windings ------------------ */
  for (let j = 0; j < counts.inner; j += 1) {
    const t = Math.min(1, Math.max(0, (j + 0.5) / counts.inner
      + (rand() - 0.5) * 0.06));
    const h = helixAt(t);   // the single source of truth for the curve
    const angle = h.angle + (rand() - 0.5) * 0.9;
    const r = WISP_R_MIN + WISP_R_SPAN * rand();
    /* Half a pitch above or below the winding at this azimuth — the
       vertical gap between turns, where a small shape slides past the
       camera without sitting on a photograph. */
    const y = h.y + (j % 2 === 0 ? 1 : -1) * (HALF_PITCH * 0.75
      + HALF_PITCH * 0.25 * rand());
    const size = WISP_SIZE_MIN + WISP_SIZE_SPAN * rand();
    const idx = 3 + (j % 2);
    buckets[idx].push({
      x: Math.sin(angle) * r,
      y,
      z: Math.cos(angle) * r,
      r,
      sx: size * (rand() < 0.5 ? -1 : 1),
      sy: size,
      shearGain: SHEAR_GAIN * (0.7 + 0.6 * rand()),
      ...common(SPECIES[idx]),
    });
  }

  /* Back-to-front WITHIN each draw: radius-from-axis descending — the
     rotation-invariant proxy for depth (see the header for the tradeoff). */
  for (let i = 0; i < buckets.length; i += 1) {
    buckets[i].sort((a, b) => b.r - a.r);
  }
  return buckets;
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/* The inert stand-in, same shape as mist.js's: the site loses the ink
   field and notices nothing else — and says nothing about it. */
function inertField() {
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

/* initMistField(scene, spiralGroup, quality, { renderer })
     → { update(TIMELINE, frame, dt), setIntensity(v), pulse(strength),
         setEraColors(colors), setDensity(f), dispose(), count }

   NEVER throws — the exact contract initMist keeps, so the orchestrator
   can swap the two on a query flag without a second code path. `scene` is
   accepted for symmetry and deliberately unused: the field belongs to the
   spiral, not the world. */
export function initMistField(scene, spiralGroup, quality, options = {}) {
  try {
    return buildField(scene, spiralGroup, quality, options) || inertField();
  } catch (err) {
    return inertField();
  }
}

function buildField(scene, spiralGroup, quality, { renderer } = {}) {
  if (!spiralGroup || !renderer) return inertField();

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* Reduced motion freezes the permitted life (breath + roll ride on
     uTime) and clamps the velocity shear to 20% — the same convention
     spiral.js applies to every velocity-driven effect. */
  const motionScale = reduced ? 0 : 1;
  const smearScale = reduced ? 0.2 : 1;

  const counts = COUNTS[(quality && quality.name)] || DEFAULT_COUNT;
  const buckets = buildLayout(counts);
  const loader = buildTextureUnits(renderer);

  /* ---- shared uniforms: ONE object each, referenced by all five
     materials — one write per frame reaches the whole field. ----------- */
  const eraColors = DEFAULT_ERAS.map((hex) => new THREE.Color(hex));
  const shared = {
    uTime: { value: 3.17 },        // non-zero: a frozen field still varies
    uIntensity: { value: 1 },
    uPulse: { value: 0 },
    uFocusY: { value: 0 },
    uSpin: { value: 0 },
    uEraColors: { value: eraColors },
    uVoid: { value: new THREE.Color('#101226') },   // ledger overwrites live
  };

  /* One unit quad, shared by all five instanced geometries — same GPU
     buffers, five instance streams. */
  const basePlane = new THREE.PlaneGeometry(1, 1);

  const meshes = [];
  const geometries = [];
  const materials = [];
  let total = 0;

  /* Sequence the five draws far → near by mean radius (wisp species carry
     the near instances), continuing the scene's ladder: cards 0, thread 1,
     fireflies 2, mist layer 3.x. */
  const order = buckets
    .map((list, i) => ({
      i,
      meanR: list.length
        ? list.reduce((sum, inst) => sum + inst.r, 0) / list.length : 0,
    }))
    .sort((a, b) => b.meanR - a.meanR);

  order.forEach(({ i }, rank) => {
    const list = buckets[i];
    if (!list.length) return;
    const n = list.length;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(basePlane.getIndex());
    geo.setAttribute('position', basePlane.getAttribute('position'));
    geo.setAttribute('uv', basePlane.getAttribute('uv'));

    const iPos = new Float32Array(n * 3);
    const iScale = new Float32Array(n * 2);
    const iSeed = new Float32Array(n * 4);
    const iMisc = new Float32Array(n * 4);
    for (let k = 0; k < n; k += 1) {
      const inst = list[k];
      iPos[k * 3] = inst.x;
      iPos[k * 3 + 1] = inst.y;
      iPos[k * 3 + 2] = inst.z;
      iScale[k * 2] = inst.sx;
      iScale[k * 2 + 1] = inst.sy;
      iSeed[k * 4] = inst.phase;
      iSeed[k * 4 + 1] = inst.breathFreq;
      iSeed[k * 4 + 2] = inst.rollAmp;
      iSeed[k * 4 + 3] = inst.rollFreq;
      iMisc[k * 4] = inst.shearGain;
      iMisc[k * 4 + 1] = inst.ampVar;
      iMisc[k * 4 + 2] = inst.hueJit;
      iMisc[k * 4 + 3] = inst.bodyVar;
    }
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(iScale, 2));
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 4));
    geo.setAttribute('iMisc', new THREE.InstancedBufferAttribute(iMisc, 4));
    geo.instanceCount = n;

    const material = new THREE.ShaderMaterial({
      vertexShader: mistFieldVertex,
      fragmentShader: mistFieldFragment,
      defines: { HELIX_H: HEIGHT.toFixed(1) },
      uniforms: {
        uTime: shared.uTime,
        uIntensity: shared.uIntensity,
        uPulse: shared.uPulse,
        uFocusY: shared.uFocusY,
        uSpin: shared.uSpin,
        uEraColors: shared.uEraColors,
        uVoid: shared.uVoid,
        uMap: { value: loader.units[i].texture },
      },
      transparent: true,
      /* Premultiplied: One / OneMinusSrcAlpha. The single pass both
         occludes (body alpha) and emits (glow outside the alpha) — the
         two-layer colour model, one draw. */
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      /* Depth TEST on: ink behind a card hides, ink in front wraps — the
         reason this reads as volume. Depth WRITE off: billboards never
         punch holes in each other. */
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,   // mirrored instances flip their winding
      fog: false,               // the shader carries its own depth manners
    });

    const mesh = new THREE.Mesh(geo, material);
    mesh.renderOrder = 3 + rank * 0.02;
    mesh.frustumCulled = false;   // instances span the whole helix
    spiralGroup.add(mesh);

    meshes.push({ mesh, geo, n });
    geometries.push(geo);
    materials.push(material);
    total += n;
  });

  /* ---- per-frame state (numbers only — zero allocation) -------------- */
  let intensity = 1;
  let intensityTarget = 1;
  let surge = 0;
  let prevSpin = 0;
  let spinSmooth = 0;
  let disposed = false;

  const scratchA = new THREE.Color();
  const scratchB = new THREE.Color();

  const api = {
    /* Seven float writes and one colour copy — the whole CPU cost. */
    update(TIMELINE, frame, dt) {
      if (disposed) return;
      const step = Math.min(Math.max(dt || 0, 0), 0.05);

      intensity += (intensityTarget - intensity)
        * (1 - Math.exp(-INTENSITY_LAMBDA * step));
      surge *= Math.exp(-PULSE_DECAY * step);
      if (surge < 1e-3) surge = 0;

      /* The world rig's own angular velocity, rebuilt exactly as
         spiral.js builds it, smoothed on the same time constant — the
         shear can never disagree with the streaks about how fast the
         world is moving. */
      if (TIMELINE && step > 0) {
        const spinVel = (TIMELINE.spinOffset - prevSpin) / step;
        const spinTarget = -(TIMELINE.velocity * TURNS * TWO_PI + spinVel);
        spinSmooth += (spinTarget - spinSmooth)
          * (1 - Math.exp(-VEL_LAMBDA * step));
      }
      if (TIMELINE) prevSpin = TIMELINE.spinOffset;

      shared.uTime.value += step * motionScale;
      shared.uIntensity.value = intensity;
      shared.uPulse.value = surge;
      shared.uSpin.value = spinSmooth * smearScale;
      if (TIMELINE) shared.uFocusY.value = -TIMELINE.smooth * HEIGHT;

      /* The body term grounds in the ledger's LIVE background, so the
         ink's weight always reads against tonight's void, not a constant. */
      if (frame && frame.world && frame.world.bg) {
        shared.uVoid.value.copy(frame.world.bg);
      }
    },

    /* 0..1 density dial, eased — same semantics the app already speaks:
       1 = the tuned resting look, 0.15 = a staged photograph's quiet room. */
    setIntensity(v) {
      const num = Number(v);
      intensityTarget = Number.isFinite(num)
        ? Math.min(1, Math.max(0, num)) : 1;
    },

    /* One-shot: billboards within ±3 units of the focus height swell +35%
       and brighten +50%, decaying in ~1.2s. The arrangement never moves. */
    pulse(strength) {
      const num = Number(strength);
      if (!Number.isFinite(num) || num <= 0) return;
      surge = Math.min(PULSE_MAX, surge + num);
    },

    /* Any number of era tints resampled onto the shader's fixed six —
       the ledger's era count is data, not a contract (as mist.js). */
    setEraColors(colors) {
      if (!Array.isArray(colors) || !colors.length) return;
      const count = colors.length;
      for (let i = 0; i < eraColors.length; i += 1) {
        const u = count > 1 ? (i / (eraColors.length - 1)) * (count - 1) : 0;
        const a = Math.min(count - 1, Math.floor(u));
        const b = Math.min(count - 1, a + 1);
        try {
          scratchA.set(colors[a]);
          scratchB.set(colors[b]);
        } catch (err) {
          return;   // a malformed entry leaves the palette be
        }
        eraColors[i].copy(scratchA).lerp(scratchB, u - a);
      }
    },

    /* The U7 governor's thinning hook. Instances are ordered far → near,
       so trimming the tail sheds the NEAREST billboards first — which are
       exactly the most fill-expensive ones. Cheapest possible demotion. */
    setDensity(fraction) {
      const f = Math.min(1, Math.max(0, Number(fraction) || 0));
      let kept = 0;
      for (let i = 0; i < meshes.length; i += 1) {
        const keep = Math.floor(meshes[i].n * f);
        meshes[i].geo.instanceCount = keep;
        kept += keep;
      }
      api.count = kept;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      loader.cancel();
      for (let i = 0; i < meshes.length; i += 1) {
        const { mesh } = meshes[i];
        if (mesh.parent) mesh.parent.remove(mesh);
      }
      for (let i = 0; i < geometries.length; i += 1) geometries[i].dispose();
      for (let i = 0; i < materials.length; i += 1) materials[i].dispose();
      for (let i = 0; i < loader.units.length; i += 1) {
        loader.units[i].texture.dispose();
      }
      basePlane.dispose();
      api.count = 0;
    },

    count: total,
  };

  return api;
}
