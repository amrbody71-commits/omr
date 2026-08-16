/* intro.js — THE OPENING: nine seconds, skippable at any frame, played OVER
   the live scene. Nothing here is a video of the site; it is the site,
   held in the dark until it is born.

   ── THE BEATS (seconds, one paused GSAP timeline drives all of them) ──
     0.00 → 0.60  VOID       absolute black; ONE point of light on the axis;
                             the world sits at 4% exposure
     0.60 → 3.20  HEARTBEAT  an ECG writes itself left → right, drawn as if
                             by a single travelling light: a hot overbright
                             head, a comet tail decaying behind it, dust in
                             the air catching the light as it passes
     3.20 → 4.20  GATHER     the line spirals inward — the collapse target
                             ROTATES as it shrinks, so the trace winds into
                             a knot instead of being sucked in a straight
                             line — and trembles for the last ~250ms
     4.20 → 4.50  IGNITION   three things on the same frame:
                               a) the pillar is born — light runs UP and
                                  DOWN the axis at ~90 units/second
                               b) a real ink detonation — ink-bloom.mp4
                                  one-shot on oversized camera-facing
                                  quads (photographic plumes if the video
                                  is not there), gold → amber
                               c) the frame blows to near-white for ~180ms
     4.50 → 7.50  REVEAL     the white falls off into drifting ink, the
                             camera descends into the top of the helix, the
                             ink thins and the first photograph is there
     5.50 → 8.20  TITLE      عُمر develops like a photograph out of the ink
     9.00         HANDOFF    exposure 1, camera 0, scroll free, onDone

   ── THE TRICK (why it reads as one continuous take) ──────────────────
   The whiteout is a CUT-HIDER. While the frame is blown out, the world's
   exposure multiplier ramps 4% → 100% underneath it — an enormous change
   that would otherwise read as a fade-up. It completes entirely inside the
   180ms hold, so when the white falls away the spiral is simply THERE,
   fully formed, and nothing was seen to arrive.

   ── EXPOSURE COMPENSATION ────────────────────────────────────────────
   js/post.js applies the ledger's exposure once, at the end of the chain.
   Every intro material multiplies by uComp = 1/exposure (capped at
   1/EXP_FLOOR, so it is EXACT at the floor and never over-corrects), which
   makes the intro's authored brightness independent of how dark the world
   is being held: ACES(exposure · authored/exposure) = ACES(authored). By
   the time the exposure ramp finishes, uComp is 1 and the intro's last
   embers are lit exactly like everything else.

   ── MEDIA IS NEVER ON THE CRITICAL PATH ──────────────────────────────
   ONE <video> element, created at T_MEDIA (2.0s — 2.2 seconds of lead on
   the detonation) and only after a silent HEAD probe says the file is
   there, so a missing asset costs zero console noise. `canplay` gets 1.2s;
   the seek to the dense part of the arc gets 0.6s more. Miss either and
   the detonation plays on the photographic plumes instead — the decision
   is made ~1s BEFORE the beat that needs it, so there is nothing to stall.

   ── FAIL-SAFE ────────────────────────────────────────────────────────
   Every path — GPGPU refusing to init, no float targets, no media, no DOM
   nodes, reduced motion, base tier, skip at any frame, dispose mid-flight
   — lands in the SAME done state: exposure 1, camera offset 0, onDone
   fired (which is where app.js unlocks the scroll). The site cannot wedge
   on the intro.

   ── THE THREE CONSTANTS MOST LIKELY TO WANT A NUDGE ON SCREEN ────────
   WHITE_PEAK (how completely the cut is hidden), BASE_GAIN (the trail's
   master brightness, which additive overdraw multiplies by tens), and
   INK_GAIN (how much of the frame the detonation owns). */

import * as THREE from 'three';
import { gsap } from 'gsap';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import {
  ecgY,
  introPositionShader,
  introVelocityShader,
  introPointVertex,
  introPointFragment,
  introPlateVertex,
  introLampFragment,
  introDustFragment,
  introInkVertex,
  introInkFragment,
  introFlashFragment,
  introPillarFragment,
} from './shaders/intro.glsl.js';

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const PLANE_Z = -10;      // camera-local depth the trace is drawn at
const EXP_START = 0.06;   // what app.js holds while this module is in flight
const EXP_FLOOR = 0.04;   // the void — darker still, eased into, never stepped
const COMP_MAX = 1 / EXP_FLOOR;   // 25 — exact compensation at the floor
const CAM_DROP = 10;      // units the camera falls into the birth pose

const BASE_GAIN = 0.036;  // per-point emission before overdraw and comp
const KNOT_PEAK = 1.15;   // trail gain through the gather (see the header)
const BURST_PEAK = 2.5;   // …and on the detonation frame
const WHITE_PEAK = 5.0;   // authored white; ACES saturates near 4.5
const INK_GAIN = 1.15;    // master brightness of the ink detonation
const PILLAR_SPEED = 90;  // units/second the axis light travels
const PILLAR_REACH = 130; // …until it has covered this much of the axis

const CATCHUP = 0.35;     // skip → the world catches up over this long
const SKIP_FADE = 0.24;   // …and the intro's own light leaves over this
const GRACE_MS = 260;     // clicks in the first moments are not skips

/* beats (seconds) */
const T_VOID = 0.60;
const T_DRAW = 2.60;
const T_GATHER = 3.20;    // T_VOID + T_DRAW
const T_KNOT = 1.00;
const T_IGNITE = 4.20;    // T_GATHER + T_KNOT
const T_BURST = 2.25;     // sim burst length → freeze at 6.45
const T_TITLE = 5.50;
const T_TOTAL = 9.00;
const T_MEDIA = 2.00;     // the video is armed here, 2.2s before it is needed
const T_LEAN = 2.50;      // reduced motion / base tier: the whole intro

const MEDIA_TIMEOUT = 1200;   // canplay must land inside this
const SEEK_TIMEOUT = 600;     // …and the seek inside this
const SEEK_TO = 1.15;         // seconds into ink-bloom.mp4: instant density

const TEX_DIR = 'assets/textures/';
const VIDEO_URL = 'assets/video-tex/ink-bloom.mp4';

/* The ink quads: few and large, never many and small — the whiteout frames
   are the expensive ones and overdraw is what costs there. Scales are in
   units of the frustum WIDTH at the ink plane; `lag` staggers the growth so
   three plates read as one expanding volume rather than three balloons. */
const INK_QUADS = [
  { rot: 0.00, zoom: 1.00, s0: 0.30, s1: 1.55, dx: 0.006, dy: 0.004, lag: 0.00, w: 1.00 },
  { rot: 2.10, zoom: 1.24, s0: 0.22, s1: 1.16, dx: -0.009, dy: 0.006, lag: 0.07, w: 0.72 },
  { rot: 4.35, zoom: 0.88, s0: 0.38, s1: 0.90, dx: 0.004, dy: -0.008, lag: 0.14, w: 0.55 },
];
const INK_PLATES = ['ink-plume-a.png', 'ink-plume-b.png', 'ink-plume-c.png'];

/* Sim resolution. base tier never gets here (guarded in initIntro), so the
   two rungs that remain are mid → 128² (16k) and high → 256² (65k). */
function simSize(tier) {
  return tier === 'high' ? 256 : 128;
}

/* ------------------------------------------------------------------ */
/* textures: procedural at birth, photographic when the files are there */
/* ------------------------------------------------------------------ */

/* Same contract js/mistfield.js keeps: every unit is VALID from the first
   frame (a painted canvas), one silent HEAD probe gates the batch, and each
   photograph paints over its own canvas as it arrives — an in-place upgrade
   with no material churn. A missing assets/ directory is a normal outcome
   and logs nothing at all. */

function makeUnit(size, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paint(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  /* Intensity DATA, not colour — the shaders shape it. Matches mistfield. */
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { canvas, ctx, texture, dead: false };
}

function paintSpark(ctx, S) {
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

function paintDust(ctx, S) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 900; i += 1) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 0.6 + Math.random() * Math.random() * 3.2;
    const a = 0.10 + Math.random() * 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* A soft-lobe cauliflower burst — the stand-in for ink-plume-*.png. It is
   only ever seen when the photographs are absent, so it aims for "dense
   luminous mass", not detail. */
function paintPlume(ctx, S) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  const tri = () => Math.random() + Math.random() - 1;
  for (let i = 0; i < 90; i += 1) {
    const x = (0.5 + tri() * 0.24) * S;
    const y = (0.5 + tri() * 0.26) * S;
    const r = (0.05 + 0.16 * Math.pow(Math.random(), 1.6)) * S;
    const a = 0.085 * (0.5 + 0.7 * Math.random());
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(4) + ')');
    g.addColorStop(0.5, 'rgba(255,255,255,' + (a * 0.4).toFixed(4) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  /* kill the rim: the cell reaches zero before its edge, so the shader's
     own edge mask has nothing to fight */
  ctx.globalCompositeOperation = 'destination-in';
  const env = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  env.addColorStop(0, 'rgba(255,255,255,1)');
  env.addColorStop(0.55, 'rgba(255,255,255,1)');
  env.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return !!(res && res.ok);
  } catch (err) {
    return false;
  }
}

async function grabBitmap(url) {
  try {
    const res = await fetch(url);
    if (!res || !res.ok) return null;
    const blob = await res.blob();
    if (!blob || !blob.size) return null;
    return await createImageBitmap(blob);
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/* initIntro({ renderer, scene, camera, quality })
     → { start, update, getExposureScale, getCameraOffsetY, getPillarIgnition,
         onDone, dispose, skip }
   Never throws for a reason the caller can act on: a broken GPGPU path
   degrades in place to the still-ink sequence, and that degrades to the
   title-and-exposure-ramp sequence. */
export function initIntro({ renderer, scene, camera, quality } = {}) {
  let reduced = false;
  try {
    reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    reduced = false;
  }

  const tier = (quality && quality.name) || 'high';
  const hasStage = !!(renderer && scene && camera);
  /* FULL is the nine-second sequence. Reduced motion and the base tier get
     the LEAN one: the same ink, gently, over an exposure ramp, in 2.5s —
     and no flash of any kind, which is the whole point of asking. */
  let full = hasStage && !reduced && tier !== 'base';

  /* The single state object every getter and uniform reads. GSAP writes it,
     update() fans it out — so there is exactly one place time lives. */
  const P = {
    phase: 0,
    phaseT: 0,
    head: 0,
    fade: 0,
    lamp: 0,
    dust: 0,
    ink: 0,
    inkGrow: 0,
    inkWarm: 0.15,
    inkCover: 1,
    white: 0,
    seed: 0,
    pillarFlash: 0,
    pillarReach: 0,
    pillarIgnite: 0,
    master: 1,
    exposure: EXP_START,
    camY: hasStage && full ? CAM_DROP : 0,
  };

  const doneCbs = [];
  let started = false;
  let finished = false;
  let disposed = false;
  let skipping = false;
  let released = false;
  let releaseAt = -1;       // seconds; a belt-and-braces deadline in update()
  let elapsed = 0;
  let startedAt = 0;

  /* ---------------- DOM: title + skip ---------------------------------- */
  const titleEl = document.getElementById('intro-title');
  const skipEl = document.getElementById('intro-skip');
  let titleGated = false;
  let lastTitleOpacity = -1;

  function onKey(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar'
      || e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      skip();
    }
  }
  function onSkipClick(e) {
    e.preventDefault();
    skip();
  }
  /* A click anywhere skips — but not the one that merely gave the window
     focus, which is why the first quarter-second does not count. */
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (performance.now() - startedAt < GRACE_MS) return;
    skip();
  }

  function clearTitleGate() {
    titleGated = false;
    lastTitleOpacity = -1;
    if (titleEl) titleEl.style.opacity = '';
  }

  /* ---------------- stage --------------------------------------------- */
  let gpu = null;
  let posVar = null;
  let velVar = null;
  let points = null;
  let simU = null;      // shared: the SAME uniform objects both sim shaders use
  let pointU = null;
  let rig = null;       // camera-parented; holds every screen-locked plate
  let plateGeo = null;
  let lamp = null;
  let dustPlate = null;
  let flash = null;
  let pillar = null;
  let cameraWasRoot = false;
  let countNorm = 1;
  let sizeGain = 1;

  const inkMeshes = [];         // { mesh, spec, u:{...} }
  const disposables = [];       // textures we own
  let sparkUnit = null;
  let dustUnit = null;
  const plumeUnits = [];

  /* media */
  let videoEl = null;
  let videoTex = null;
  let videoReady = false;
  let videoAspect = 16 / 9;
  let mediaArmed = false;
  let mediaTimer = 0;
  let seekTimer = 0;

  /* ---------------- particles (full tier only) -------------------------- */
  function buildParticles() {
    const size = simSize(tier);
    const count = size * size;
    /* Additive overdraw scales with particles-per-column, so the 256² tier
       would read twice as hot as the 128² one. Normalise and both tiers
       land on the same picture — only the grain gets finer. */
    countNorm = 128 / size;
    sizeGain = size === 256 ? 0.86 : 1;

    gpu = new GPUComputationRenderer(size, size, renderer);

    const dtPos = gpu.createTexture();
    const dtVel = gpu.createTexture();
    const pArr = dtPos.image.data;
    const vArr = dtVel.image.data;

    /* Start life bunched where the front is about to appear; uFade hides
       the first settling frames anyway. */
    const half = Math.tan((camera.fov * Math.PI) / 360) * Math.abs(PLANE_Z);
    const span = half * (camera.aspect || 1.6) * 0.86;
    for (let i = 0; i < count; i += 1) {
      pArr[i * 4] = -span + (Math.random() - 0.5) * 0.5;
      pArr[i * 4 + 1] = (Math.random() - 0.5) * 0.5;
      pArr[i * 4 + 2] = (Math.random() - 0.5) * 0.2;
      pArr[i * 4 + 3] = Math.random();      // the seed, carried forever
      vArr[i * 4] = 0;
      vArr[i * 4 + 1] = 0;
      vArr[i * 4 + 2] = 0;
      vArr[i * 4 + 3] = 1;
    }

    velVar = gpu.addVariable('textureVelocity', introVelocityShader, dtVel);
    posVar = gpu.addVariable('texturePosition', introPositionShader, dtPos);
    gpu.setVariableDependencies(velVar, [posVar, velVar]);
    gpu.setVariableDependencies(posVar, [posVar, velVar]);

    simU = {
      uDelta: { value: 0 },
      uPhase: { value: 0 },
      uPhaseT: { value: 0 },
      uHead: { value: 0 },
      uSpan: { value: span },
      uAmp: { value: half * 0.42 },
      uTime: { value: 0 },
    };
    /* One uniform object per name, referenced by BOTH materials — one write
       per frame reaches the whole sim (the house pattern, see particles.js). */
    velVar.material.uniforms.uDelta = simU.uDelta;
    velVar.material.uniforms.uPhase = simU.uPhase;
    velVar.material.uniforms.uPhaseT = simU.uPhaseT;
    velVar.material.uniforms.uHead = simU.uHead;
    velVar.material.uniforms.uSpan = simU.uSpan;
    velVar.material.uniforms.uAmp = simU.uAmp;
    velVar.material.uniforms.uTime = simU.uTime;
    posVar.material.uniforms.uDelta = simU.uDelta;

    const err = gpu.init();
    if (err !== null) throw new Error(err);

    /* one vec3 per particle: xy = its texel reference, z unused */
    const refs = new Float32Array(count * 3);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        refs[i * 3] = (x + 0.5) / size;
        refs[i * 3 + 1] = (y + 0.5) / size;
        refs[i * 3 + 2] = 0;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(refs, 3));

    pointU = {
      uPos: { value: null },
      uVel: { value: null },
      uSprite: { value: sparkUnit.texture },
      uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) },
      uFade: { value: 0 },
      uPhase: simU.uPhase,
      uPhaseT: simU.uPhaseT,
      uHead: simU.uHead,
      uSizeGain: { value: sizeGain },
      uWarm: { value: 0 },
      uGain: { value: BASE_GAIN * countNorm * COMP_MAX },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: introPointVertex,
      fragmentShader: introPointFragment,
      uniforms: pointU,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,     // the intro owns the frame; nothing occludes it
      fog: false,
    });

    points = new THREE.Points(geo, material);
    points.renderOrder = 10;
    points.frustumCulled = false;   // positions live in a texture
    points.visible = false;
    rig.add(points);
  }

  /* ---------------- the plates ----------------------------------------- */

  function plate(fragmentShader, uniforms, renderOrder, vertexShader) {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertexShader || introPlateVertex,
      fragmentShader,
      uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(plateGeo, material);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  function buildStage() {
    plateGeo = new THREE.PlaneGeometry(1, 1);

    rig = new THREE.Group();
    rig.position.set(0, 0, PLANE_Z);
    camera.add(rig);
    /* the camera joins the graph so its children are traversed (it had no
       parent — checked across js/) */
    if (!camera.parent) {
      scene.add(camera);
      cameraWasRoot = true;
    }

    /* the ink: 3 plates on high, 2 elsewhere — large, never many */
    const quads = tier === 'high' && full ? 3 : 2;
    for (let i = 0; i < quads; i += 1) {
      const spec = INK_QUADS[i];
      const unit = makeUnit(256, paintPlume);
      disposables.push(unit.texture);
      plumeUnits.push(unit);
      const u = {
        uMap: { value: unit.texture },
        uRot: { value: spec.rot },
        uZoom: { value: new THREE.Vector2(spec.zoom, spec.zoom) },
        uDrift: { value: new THREE.Vector2(0, 0) },
        uAmount: { value: 0 },
        uWarm: { value: 0.15 },
        uCore: { value: 1.4 },
        uComp: { value: 1 },
      };
      const mesh = plate(introInkFragment, u, 14 + i, introInkVertex);
      mesh.position.z = 0.9 + i * 0.35;
      rig.add(mesh);
      inkMeshes.push({ mesh, spec, u });
    }

    if (!full) return;   // lean: ink stills and the exposure ramp, nothing else

    /* Painted here rather than at the top of the function: the lean path
       never draws a spark or a mote, and painting a thousand gradients it
       will not use is a hitch for nothing. */
    sparkUnit = makeUnit(128, paintSpark);
    dustUnit = makeUnit(256, paintDust);
    disposables.push(sparkUnit.texture, dustUnit.texture);

    /* the dust the light passes through */
    const dustU = {
      uDust: { value: dustUnit.texture },
      uGain: { value: 0 },
      uHead: { value: 0 },
      uSpan: { value: 1 },
      uAmp: { value: 1 },
      uTime: { value: 0 },
      uComp: { value: 1 },
      uExtent: { value: new THREE.Vector2(1, 1) },
    };
    dustPlate = plate(introDustFragment, dustU, 8);
    dustPlate.position.z = -0.6;
    rig.add(dustPlate);

    /* the light that writes the line */
    const lampU = {
      uSprite: { value: sparkUnit.texture },
      uGain: { value: 0 },
      uWarm: { value: 0 },
      uComp: { value: 1 },
    };
    lamp = plate(introLampFragment, lampU, 11);
    lamp.position.z = 0.35;
    rig.add(lamp);

    /* the cut-hider, nearest the eye */
    const flashU = { uWhite: { value: 0 }, uComp: { value: 1 } };
    flash = plate(introFlashFragment, flashU, 20);
    flash.position.z = 3.5;
    rig.add(flash);

    /* the pillar: WORLD-static, on the axis, yawed to face the camera.
       depthTest stays OFF — the seed in the void has to be guaranteed
       visible, and the cards write depth even while they are invisible at
       4% exposure. The cost is that the decaying flash adds light in front
       of a card that crosses the axis between 4.5s and 7s; it is additive
       light in air, which is what it would be anyway. */
    const pillarU = {
      uReach: { value: 0 },
      uFlash: { value: 0 },
      uSeed: { value: 0 },
      uComp: { value: 1 },
      uTime: { value: 0 },
      /* half-extents. 4 across is wide enough that the body gaussian has
         decayed to ~0.006 by the quad's own edge — no vertical seam, ever —
         and 100 tall runs the light far outside the frustum before the
         plate ends. */
      uSize: { value: new THREE.Vector2(4, 100) },
    };
    pillar = plate(introPillarFragment, pillarU, 9);
    pillar.scale.set(8, 200, 1);
    scene.add(pillar);
  }

  /* ---------------- the photographs (silent, off the critical path) ----- */
  let upgradeCancelled = false;

  async function upgradeTextures() {
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return;
    /* ONE probe gates the batch: the plates are generated as a set, so one
       miss means all missing and the network chatter stays at a single line. */
    if (!await headOk(TEX_DIR + 'spark-point.png')) return;
    const wanted = [];
    if (sparkUnit) wanted.push({ unit: sparkUnit, file: 'spark-point.png' });
    if (dustUnit) wanted.push({ unit: dustUnit, file: 'dust-motes.png' });
    for (let i = 0; i < plumeUnits.length; i += 1) {
      wanted.push({ unit: plumeUnits[i], file: INK_PLATES[i] });
    }
    await Promise.all(wanted.map(async (w) => {
      const bmp = await grabBitmap(TEX_DIR + w.file);
      if (!bmp) return;
      if (upgradeCancelled || w.unit.dead || !w.unit.ctx) {
        if (typeof bmp.close === 'function') bmp.close();
        return;
      }
      /* Full-resolution swap: resizing the canvas clears it, the photo is
         drawn 1:1, needsUpdate re-uploads. No material or geometry churn. */
      w.unit.canvas.width = bmp.width;
      w.unit.canvas.height = bmp.height;
      w.unit.ctx.drawImage(bmp, 0, 0);
      if (typeof bmp.close === 'function') bmp.close();
      w.unit.texture.needsUpdate = true;
    }));
  }

  /* ---------------- the video (one element, one clip, one shot) --------- */

  function clearMediaTimers() {
    if (mediaTimer) { clearTimeout(mediaTimer); mediaTimer = 0; }
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = 0; }
  }

  function dropVideo() {
    clearMediaTimers();
    videoReady = false;
    if (videoTex) {
      videoTex.dispose();
      videoTex = null;
    }
    if (videoEl) {
      const el = videoEl;
      videoEl = null;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();          // release the decoder + the network slot
      } catch (err) {
        /* the element is going away regardless */
      }
    }
  }

  async function armMedia() {
    if (mediaArmed || !full || skipping || finished || disposed) return;
    mediaArmed = true;
    /* Probe BEFORE the element exists: a 404 on a media element is the one
       kind of missing asset that would print to the console. */
    if (typeof fetch !== 'function') return;
    if (!await headOk(VIDEO_URL)) return;
    if (skipping || finished || disposed) return;

    let el;
    try {
      el = document.createElement('video');
    } catch (err) {
      return;
    }
    el.muted = true;
    el.defaultMuted = true;
    el.loop = false;            // a GROWTH ARC: it is played exactly once
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('muted', '');
    el.preload = 'auto';
    videoEl = el;

    const onSeeked = () => {
      if (videoEl !== el || finished || disposed) return;
      clearMediaTimers();
      videoReady = true;
    };
    const onCanPlay = () => {
      if (videoEl !== el || finished || disposed) return;
      clearMediaTimers();
      if (el.videoWidth && el.videoHeight) videoAspect = el.videoWidth / el.videoHeight;
      try {
        videoTex = new THREE.VideoTexture(el);
        videoTex.colorSpace = THREE.NoColorSpace;
        videoTex.wrapS = THREE.ClampToEdgeWrapping;
        videoTex.wrapT = THREE.ClampToEdgeWrapping;
        videoTex.minFilter = THREE.LinearFilter;
        videoTex.magFilter = THREE.LinearFilter;
        videoTex.generateMipmaps = false;
      } catch (err) {
        videoTex = null;
        return;
      }
      /* t=0 is a small core; the detonation needs density on frame one. */
      el.addEventListener('seeked', onSeeked, { once: true });
      seekTimer = setTimeout(() => {
        seekTimer = 0;
        /* the seek never reported, but the decoder has a frame — a still
           frame of real ink still beats no ink */
        if (videoEl === el && el.readyState >= 2) videoReady = true;
      }, SEEK_TIMEOUT);
      try {
        el.currentTime = SEEK_TO;
      } catch (err) {
        videoReady = el.readyState >= 2;
      }
    };

    el.addEventListener('canplay', onCanPlay, { once: true });
    el.addEventListener('error', () => {
      if (videoEl === el) dropVideo();
    }, { once: true });
    /* If canplay never lands, the detonation plays on the photographs. */
    mediaTimer = setTimeout(() => {
      mediaTimer = 0;
      if (!videoReady && videoEl === el) dropVideo();
    }, MEDIA_TIMEOUT);

    try {
      el.src = VIDEO_URL;
      el.load();
    } catch (err) {
      dropVideo();
    }
  }

  /* ---------------- timeline callbacks --------------------------------- */
  /* gsap may replay callbacks it is driven past, so every one of these is
     inert while skipping, finished or disposed. */

  function fireInk() {
    if (skipping || finished || disposed) return;
    if (videoReady && videoTex && videoEl) {
      const play = videoEl.play();
      if (play && play.catch) play.catch(() => {});
      /* One clip, three crops: each quad keeps its own rotation, zoom and
         drift, so the same frame never reads as three copies. */
      for (let i = 0; i < inkMeshes.length; i += 1) {
        const q = inkMeshes[i];
        q.u.uMap.value = videoTex;
        q.u.uZoom.value.set(q.spec.zoom, q.spec.zoom / videoAspect);
      }
    }
  }

  function releaseInk() {
    for (let i = 0; i < inkMeshes.length; i += 1) {
      inkMeshes[i].mesh.visible = false;
    }
    dropVideo();
  }

  function developTitle() {
    if (!titleEl || skipping || finished || disposed) return;
    titleEl.classList.remove('develop', 'develop-quick');
    void titleEl.offsetWidth;                    // restart the keyframes
    titleEl.classList.add(full ? 'develop' : 'develop-quick');
    /* Full sequence only: the title's opacity is masked by how much ink is
       still in front of it, so it resolves OUT of the detonation instead of
       arriving on top of it. */
    if (full) titleGated = true;
  }

  /* ---------------- the timeline --------------------------------------- */
  const tl = gsap.timeline({ paused: true, onComplete: finish });

  function buildTimeline() {
    if (!full) {
      /* LEAN — reduced motion or base tier. Ink stills breathing over a
         gentle exposure ramp, the title developing quick, 2.5 seconds, and
         not one frame of flash. */
      tl.to(P, { exposure: 1, duration: 1.60, ease: 'power2.out' }, 0)
        .to(P, { ink: inkMeshes.length ? 0.55 : 0, duration: 0.90, ease: 'power2.out' }, 0)
        .to(P, { inkGrow: 1, duration: T_LEAN, ease: 'power1.out' }, 0)
        .to(P, { inkWarm: 0.7, duration: T_LEAN, ease: 'none' }, 0)
        .to(P, { ink: 0, duration: 1.00, ease: 'power2.inOut' }, 1.40)
        .call(developTitle, null, 0.10)
        .call(releaseInk, null, 2.45)
        .set(P, { phaseT: 1 }, T_LEAN);
      return;
    }

    tl
      /* ---- 1 VOID ---------------------------------------------------- */
      .set(P, { phase: 0, phaseT: 0, head: 0 }, 0)
      .to(P, { exposure: EXP_FLOOR, duration: 0.55, ease: 'power1.inOut' }, 0.02)
      .to(P, { seed: 1, duration: 0.42, ease: 'power2.out' }, 0.06)

      /* ---- 2 HEARTBEAT ----------------------------------------------- */
      .to(P, { fade: 1, duration: 0.34, ease: 'power2.out' }, T_VOID)
      .to(P, { lamp: 1, duration: 0.24, ease: 'power2.out' }, T_VOID)
      .to(P, { dust: 1, duration: 0.90, ease: 'power1.out' }, T_VOID + 0.10)
      .to(P, { phaseT: 1, duration: T_DRAW, ease: 'power1.inOut' }, T_VOID)
      .to(P, { seed: 0.20, duration: 0.90, ease: 'power1.inOut' }, T_VOID + 0.25)
      .call(armMedia, null, T_MEDIA)

      /* ---- 3 GATHER -------------------------------------------------- */
      .set(P, { phase: 1, phaseT: 0 }, T_GATHER)
      .to(P, { phaseT: 1, duration: T_KNOT, ease: 'power2.in' }, T_GATHER)
      .to(P, { fade: KNOT_PEAK, duration: 0.85, ease: 'power2.in' }, T_GATHER)
      .to(P, { lamp: 0, duration: 0.40, ease: 'power2.in' }, T_GATHER)
      .to(P, { dust: 0.30, duration: 0.70, ease: 'power1.in' }, T_GATHER + 0.20)

      /* ---- 4 IGNITION — a) the pillar, b) the ink, c) the whiteout ---- */
      .set(P, { phase: 2, phaseT: 0 }, T_IGNITE)
      .to(P, { phaseT: 1, duration: T_BURST, ease: 'none' }, T_IGNITE)
      /* a) light runs the axis: power1.out over reach/speed seconds starts
         at exactly PILLAR_SPEED units/s and decelerates from there */
      .to(P, { pillarIgnite: 1, duration: 0.30, ease: 'none' }, T_IGNITE)
      .to(P, {
        pillarReach: PILLAR_REACH,
        duration: PILLAR_REACH / PILLAR_SPEED,
        ease: 'power1.out',
      }, T_IGNITE)
      .to(P, { pillarFlash: 1, duration: 0.07, ease: 'power2.out' }, T_IGNITE)
      .to(P, { pillarFlash: 0, duration: 2.60, ease: 'power2.in' }, T_IGNITE + 0.30)
      .to(P, { seed: 0, duration: 0.10, ease: 'none' }, T_IGNITE)
      /* b) the ink detonation */
      .call(fireInk, null, T_IGNITE)
      .to(P, { ink: 1, duration: 0.10, ease: 'power2.out' }, T_IGNITE)
      .to(P, { inkGrow: 1, duration: 3.00, ease: 'power2.out' }, T_IGNITE)
      .to(P, { inkWarm: 0.85, duration: 2.40, ease: 'none' }, T_IGNITE)
      .to(P, { ink: 0, duration: 2.20, ease: 'power2.inOut' }, T_IGNITE + 0.90)
      /* c) the whiteout: up, HOLD, away */
      .to(P, { white: WHITE_PEAK, duration: 0.07, ease: 'power2.out' }, T_IGNITE)
      .to(P, { white: WHITE_PEAK, duration: 0.19, ease: 'none' }, T_IGNITE + 0.07)
      .to(P, { white: 0, duration: 0.66, ease: 'power2.in' }, T_IGNITE + 0.26)
      /* …and underneath the white, the world: the entire ignition ramp
         finishes inside the 190ms hold, so nothing is seen to arrive */
      .to(P, { exposure: 1, duration: 0.19, ease: 'power1.inOut' }, T_IGNITE + 0.07)
      .to(P, { camY: 0, duration: 2.15, ease: 'power2.inOut' }, T_IGNITE - 0.15)
      /* the trail blows out, then dies into the standing firefly field */
      .to(P, { fade: BURST_PEAK, duration: 0.08, ease: 'power2.out' }, T_IGNITE)
      .to(P, { fade: 0, duration: 2.10, ease: 'power2.in' }, T_IGNITE + 0.12)
      .to(P, { dust: 0, duration: 0.50, ease: 'power2.in' }, T_IGNITE)

      /* ---- 5/6 REVEAL + TITLE ---------------------------------------- */
      .call(developTitle, null, T_TITLE)
      .to(P, { inkCover: 0, duration: 1.30, ease: 'power2.out' }, T_TITLE - 0.10)
      .set(P, { phase: 3, phaseT: 0 }, T_IGNITE + T_BURST)
      .call(releaseParticles, null, T_IGNITE + T_BURST + 0.15)
      .call(releaseInk, null, 7.40)

      /* ---- 7 HANDOFF — the title still has 0.8s to dissolve; hold the
         timeline open so onComplete lands on the true handoff ---------- */
      .set(P, { phaseT: 1 }, T_TOTAL);
  }

  /* ---------------- teardown ------------------------------------------- */

  function releaseParticles() {
    if (points) {
      if (points.parent) points.parent.remove(points);
      points.geometry.dispose();
      points.material.dispose();
      points = null;
    }
    if (gpu) {
      /* one-shot: the standing firefly field carries the ambience from here */
      if (typeof gpu.dispose === 'function') gpu.dispose();
      gpu = null;
    }
    posVar = null;
    velVar = null;
    pointU = null;
  }

  function releaseAll() {
    if (released) return;
    released = true;
    upgradeCancelled = true;
    releaseParticles();
    releaseInk();
    for (let i = 0; i < inkMeshes.length; i += 1) {
      const mesh = inkMeshes[i].mesh;
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.material.dispose();
    }
    inkMeshes.length = 0;
    const solo = [lamp, dustPlate, flash, pillar];
    for (let i = 0; i < solo.length; i += 1) {
      const mesh = solo[i];
      if (!mesh) continue;
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.material.dispose();
    }
    lamp = null;
    dustPlate = null;
    flash = null;
    pillar = null;
    if (rig) {
      if (rig.parent) rig.parent.remove(rig);
      rig = null;
    }
    if (cameraWasRoot && camera && scene) {
      scene.remove(camera);
      cameraWasRoot = false;
    }
    if (plateGeo) { plateGeo.dispose(); plateGeo = null; }
    for (let i = 0; i < disposables.length; i += 1) disposables[i].dispose();
    disposables.length = 0;
    /* An upgrade already in flight holds its own references to these units;
       the flag is how a photograph that lands after teardown knows not to
       paint into a canvas whose texture is gone. */
    if (sparkUnit) sparkUnit.dead = true;
    if (dustUnit) dustUnit.dead = true;
    for (let i = 0; i < plumeUnits.length; i += 1) plumeUnits[i].dead = true;
    sparkUnit = null;
    dustUnit = null;
    plumeUnits.length = 0;
    clearTitleGate();
  }

  /* ---------------- build ---------------------------------------------- */
  if (hasStage) {
    try {
      buildStage();
      if (full) buildParticles();
      upgradeTextures();
    } catch (err) {
      /* Anything at all: fall back a rung rather than throw. The stage may
         be half-built, so tear it down and rebuild the lean one. */
      try {
        releaseParticles();
        releaseAll();
      } catch (inner) {
        /* nothing left to do but keep going */
      }
      released = false;
      upgradeCancelled = false;
      full = false;
      P.camY = 0;
      try {
        buildStage();
        upgradeTextures();
      } catch (inner) {
        inkMeshes.length = 0;
      }
    }
  } else {
    full = false;
  }
  buildTimeline();

  /* ---------------- lifecycle ------------------------------------------ */
  function start() {
    if (started || finished || disposed) return;
    started = true;
    startedAt = performance.now();
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onPointerDown);
    if (skipEl) skipEl.addEventListener('click', onSkipClick);
    tl.play(0);
  }

  function unbind() {
    removeEventListener('keydown', onKey);
    removeEventListener('pointerdown', onPointerDown);
    if (skipEl) skipEl.removeEventListener('click', onSkipClick);
  }

  function finish() {
    if (finished) return;
    finished = true;
    unbind();
    /* The title's own exit is the CSS parent gate: app.js drops
       body.intro-playing on this signal and #intro-title dissolves. Clearing
       the inline opacity first hands it back to the stylesheet — leaving it
       set would pin a title app.js is trying to fade. */
    clearTitleGate();
    /* Release is deferred by SKIP_FADE so a skip can fade rather than cut;
       update() enforces the deadline even if the tween never runs. */
    if (releaseAt < 0) releaseAt = elapsed + SKIP_FADE + 0.05;
    for (let i = 0; i < doneCbs.length; i += 1) {
      try {
        doneCbs[i]();
      } catch (err) {
        console.warn('[omr] intro done handler threw:', err);
      }
    }
    doneCbs.length = 0;
  }

  /* Every skip path lands here. The timeline stops where it is (no
     progress(1) storm of callbacks), the two values the WORLD reads catch
     up over CATCHUP, and the intro's own light leaves over SKIP_FADE — so
     the whole handover is done inside 0.35s from any beat. */
  function skip() {
    if (finished || disposed) return;
    skipping = true;
    tl.pause();
    tl.kill();
    gsap.killTweensOf(P);
    skipping = false;
    releaseAt = elapsed + SKIP_FADE + 0.05;
    /* Neither catch-up tween may overwrite: killTweensOf above already
       cleared the field, and `overwrite: true` resolves on the tween's
       first render — i.e. AFTER both of these exist — so it would kill the
       other one and strand the fade. */
    gsap.to(P, {
      exposure: 1,
      camY: 0,
      duration: CATCHUP,
      ease: 'power2.out',
      overwrite: false,
    });
    gsap.to(P, {
      master: 0,
      duration: SKIP_FADE,
      ease: 'power2.in',
      overwrite: false,
      onComplete: releaseAll,
    });
    finish();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    tl.kill();
    gsap.killTweensOf(P);
    P.exposure = 1;
    P.camY = 0;
    P.master = 0;
    finish();
    releaseAll();
  }

  /* ---------------- per-frame ------------------------------------------ */
  /* Zero allocation: every write below lands in an object that already
     exists. Nothing in here constructs a vector, an array or a closure. */
  function update(dt) {
    const step = Number.isFinite(dt) ? dt : 0;
    elapsed += step;

    if (released) {
      if (titleGated) clearTitleGate();
      return;
    }
    if (releaseAt >= 0 && elapsed >= releaseAt) {
      releaseAll();
      return;
    }

    /* the compensation that cancels the world's ignition ramp back out of
       everything the intro draws (see the header) */
    const comp = Math.min(COMP_MAX, 1 / Math.max(P.exposure, 1e-3));
    const m = P.master;

    /* Span and amplitude come from the LIVE lens every frame, so a resize
       or the ledger's fov drift can never crop the trace. */
    const tanHalf = Math.tan((camera ? camera.fov : 46) * Math.PI / 360);
    const aspect = (camera && camera.aspect) || 1.6;
    const half = tanHalf * Math.abs(PLANE_Z);
    const span = half * aspect * 0.86;
    const amp = half * 0.42;
    const head = P.phase < 0.5 ? Math.min(1, P.phaseT * 1.05) : 1;
    P.head = head;

    if (gpu && points && simU && pointU) {
      simU.uAmp.value = amp;
      simU.uSpan.value = span;
      simU.uDelta.value = step;
      simU.uTime.value = elapsed;
      simU.uPhase.value = P.phase;
      simU.uPhaseT.value = P.phaseT;
      simU.uHead.value = head;

      gpu.compute();

      pointU.uPos.value = gpu.getCurrentRenderTarget(posVar).texture;
      pointU.uVel.value = gpu.getCurrentRenderTarget(velVar).texture;
      pointU.uFade.value = P.fade * m;
      pointU.uWarm.value = Math.min(1, (P.phase + P.phaseT) / 2.4);
      pointU.uGain.value = BASE_GAIN * countNorm * comp;
      points.visible = P.fade * m > 0.002;
    }

    if (lamp) {
      const g = P.lamp * m;
      lamp.visible = g > 0.002;
      if (lamp.visible) {
        const u = lamp.material.uniforms;
        u.uGain.value = g * 2.6;
        u.uWarm.value = Math.min(1, P.phaseT * 0.5);
        u.uComp.value = comp;
        /* THE travelling light: placed at the head of the curve from the
           CPU's copy of the very same wave table the GPU springs onto. */
        lamp.position.x = (head - 0.5) * 2 * span;
        lamp.position.y = ecgY(head) * amp;
        /* the sprite's hot core is ~16% of the plate, so this is a ~3%-of-
           height filament inside a wide, soft halo — a lamp, not a disc */
        const s = amp * 0.9;
        lamp.scale.set(s, s, 1);
      }
    }

    if (dustPlate) {
      const g = P.dust * m;
      dustPlate.visible = g > 0.002;
      if (dustPlate.visible) {
        const u = dustPlate.material.uniforms;
        const d = Math.abs(PLANE_Z + dustPlate.position.z);
        const h = tanHalf * d * 1.04;
        const w = h * aspect;
        dustPlate.scale.set(w * 2, h * 2, 1);
        u.uExtent.value.set(w, h);
        u.uGain.value = g * 0.85;
        u.uHead.value = head;
        u.uSpan.value = span;
        u.uAmp.value = amp;
        u.uTime.value = elapsed;
        u.uComp.value = comp;
      }
    }

    if (inkMeshes.length) {
      const base = P.ink * m * INK_GAIN;
      for (let i = 0; i < inkMeshes.length; i += 1) {
        const q = inkMeshes[i];
        const a = base * q.spec.w;
        q.mesh.visible = a > 0.003;
        if (!q.mesh.visible) continue;
        const u = q.u;
        const d = Math.abs(PLANE_Z + q.mesh.position.z);
        const wide = tanHalf * d * aspect * 2;
        /* staggered growth: one expanding volume, not three balloons */
        const g = Math.min(1, Math.max(0, (P.inkGrow - q.spec.lag) / (1 - q.spec.lag)));
        const s = wide * (q.spec.s0 + (q.spec.s1 - q.spec.s0) * g);
        q.mesh.scale.set(s, s, 1);
        u.uAmount.value = a;
        u.uWarm.value = P.inkWarm;
        u.uComp.value = comp;
        u.uDrift.value.set(q.spec.dx * elapsed, q.spec.dy * elapsed);
      }
    }

    if (flash) {
      const w = P.white * m;
      flash.visible = w > 0.0008;
      if (flash.visible) {
        const u = flash.material.uniforms;
        const d = Math.abs(PLANE_Z + flash.position.z);
        const h = tanHalf * d * 2.12;      // frustum + 6% margin, both axes
        flash.scale.set(h * aspect, h, 1);
        u.uWhite.value = w;
        u.uComp.value = comp;
      }
    }

    if (pillar) {
      const f = P.pillarFlash * m;
      const s = P.seed * m;
      pillar.visible = f > 0.002 || s > 0.002;
      if (pillar.visible) {
        const u = pillar.material.uniforms;
        u.uReach.value = P.pillarReach;
        u.uFlash.value = f;
        u.uSeed.value = s * 0.55;
        u.uComp.value = comp;
        u.uTime.value = elapsed;
        /* yaw to face the eye — the camera holds x ≈ 0, but parallax pans
           it, and one atan2 a frame keeps the column edge-on forever */
        if (camera) pillar.rotation.y = Math.atan2(camera.position.x, camera.position.z);
      }
    }

    /* The title resolves OUT of the ink: while the detonation still fills
       the frame the type is held back, and it arrives as the ink thins. */
    if (titleGated && titleEl) {
      const o = Math.max(0, Math.min(1, (1 - P.inkCover * 0.92) * m));
      if (o >= 0.999) {
        clearTitleGate();                 // the stylesheet owns it again
      } else if (Math.abs(o - lastTitleOpacity) > 0.004) {
        lastTitleOpacity = o;
        titleEl.style.opacity = String(o);
      }
    }
  }

  return {
    start,
    update,
    getExposureScale: () => P.exposure,
    getCameraOffsetY: () => P.camY,
    /* 0 → 1 across the ignition and held at 1 afterwards: the pillar, once
       lit, stays lit. js/core.js can take this as a master gain when the
       orchestrator wires the two together; until then this module draws its
       own axis streak so the beat exists standalone. */
    getPillarIgnition: () => P.pillarIgnite,
    onDone(cb) {
      if (typeof cb !== 'function') return;
      if (finished) cb();
      else doneCbs.push(cb);
    },
    dispose,
    skip,
  };
}
