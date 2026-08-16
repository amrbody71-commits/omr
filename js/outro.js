/* outro.js — U10, THE ENDING. The last memory is the 2026 graduation; the
   scroll track carries ONE extra section past it (app.js appends it, and
   js/scroll.js normalizes that section to TIMELINE.smooth ∈ (1, 1.12]).
   Everything in this file is a pure function of that overshoot:

     p = clamp((smooth − 1) / 0.12, 0, 1)

   ── THE SEQUENCE ─────────────────────────────────────────────────────
     p 0.00 → 0.25  THE DESCENT ENDS. The last photograph lifts, shrinks
                    and comes APART: a few hundred motes, each carrying one
                    of its own pixels (a vertex fetch of the card's own
                    texture), fall away and down. The life's last image
                    becomes part of the dust. Stars come up, fog opens.
     p 0.15         the ending arms its media — and not one byte before.
     p 0.20 → 0.60  THE APERTURE. On the axis below, where the pillar
                    (js/core.js) and the thread converge, an eye of light
                    opens from a point: an iris with no edge, concentric
                    shells, a fan of rays (the filmed clip when it loads),
                    a halo of lit air, and dust streaming inward into it.
                    The thread's tail plunges down the axis and feeds it.
     p 0.45 → 0.86  THE FALL. The camera descends toward the aperture with
                    weight, leans forward into it and pulls a little
                    closer; the rim's chromatic split widens as it nears.
     p ≈ 0.72       THE THRESHOLD. The leading pulse of the thread arrives
                    at the tail's tip on this exact frame and the frame
                    blows to white. Under the white — and ONLY under it —
                    the world is hidden (see THE CUT below).
     p 0.72 → 1.00  BEYOND. A vast filmed nebula, a cascade of glittering
                    motes drifting down past the camera, the pillar of
                    light still running through it all, thinner now.
     p 0.80 → 1.00  THE WORDS. "to be continued —" / 2026 / عُمر. Unchanged.

   ── THE CUT (what the whiteout is FOR) ───────────────────────────────
   At p > 0.728 spiral.group is hidden — cards, thread, tail, fireflies and
   the whole ink field with it — and the deep field takes the frame. That
   is a scene change, and a scene change you can see is an edit. So it
   happens 0.008 into a gaussian whose σ is 0.055: the flash is at 98% of
   full when the world goes, the frame is already white, and what the eye
   reads is one continuous move through the light. Two things back it up
   so the cut survives even a gentle (reduced-motion) flash: the camera has
   leaned down and fallen ~11 units, which walks every remaining card out
   of frame above, and the fog collapses over p 0.58 → 0.74, which fades
   what is left toward nothing before it is ever switched off.

   ── REVERSIBILITY ────────────────────────────────────────────────────
   NOTHING here integrates. Every visible quantity — camera offsets, fog,
   the aperture's radius, every opacity, the flash, the cut, the words —
   is recomputed from p on top of the values applyLedger just wrote, so
   scrolling back up runs the ending backwards EXACTLY and holding at any
   p holds perfectly still. The only clock is `clock`, an ambient phase
   for shimmer and flow (the same licence js/thread.js, js/core.js and
   js/particles.js take); no beat, framing or brightness reads it as
   state. The only real state is `released` — the flag that says the world
   has already been handed back, so the restore runs once instead of every
   frame — and the media arm/disarm pair, which is a resource, not a look.

   ── COST ─────────────────────────────────────────────────────────────
   Draw calls, and only inside their own beat (everything else is
   visible = false): tail 1 · motes 1 · aperture 1 (a handful of large
   quads, merged) · stream 1 · flash 1 · backdrop 1 · cascade 1. Point
   counts are tier-scaled (js/quality.js, read off window.OMR_FLAGS, with
   a particle-count fingerprint as the fallback). Zero allocation per
   frame: every vector, colour and matrix below is built once.

   ── GEOMETRY NOTE, DELIBERATE ────────────────────────────────────────
   js/core.js's clearance table lists the outro tail at 6.27 from the axis.
   This build brings it all the way home — the tip converges to 0.9, inside
   the pillar's shells — because the merge IS the image: the thread of a
   life arriving in the column of light and going down it together. It is
   harmless by construction: both are additive with depthWrite:false, so an
   overlap can only ever be more light, never an intersection artifact
   (the same reasoning core.js already applies to its dust and fireflies).

   ── NEVER THROWS ─────────────────────────────────────────────────────
   app.js calls this on the boot path and once per frame forever. A build
   that cannot complete returns the inert stand-in with the same shape;
   an update that somehow throws hands the world back once and then does
   nothing at all. The site stays scrollable either way.

   THE THREE CONSTANTS most likely to want a nudge on screen: APERTURE_R
   (how much of the frame the eye fills at the threshold), FALL_DROP (how
   far the camera actually falls) and FLASH_GAIN (how hard the whiteout
   hits — the cover over the cut).

   Years only. No era names, no captions — the same rule as every other
   visible surface in this project. */

import * as THREE from 'three';
import { helixAt } from './spiral.js';
import { THREAD_RADIUS } from './thread.js';
import {
  outroTailVertex, outroTailFragment,
  outroApertureVertex, outroApertureFragment,
  outroSpriteFragment,
  outroMoteVertex, outroStreamVertex, outroCascadeVertex,
  outroScreenVertex, outroFlashFragment, outroBackdropFragment,
} from './shaders/outro.glsl.js';

/* The outro zone in TIMELINE units. scroll.js maps the extra track to
   exactly this reach, and js/cinema.js tweens to OUTRO_END. */
export const OUTRO_START = 1;
export const OUTRO_END = 1.12;
const SPAN = OUTRO_END - OUTRO_START;

/* ------------------------------------------------------------------ */
/* the dials                                                           */
/* ------------------------------------------------------------------ */

const APERTURE_R = 4.2;    // world half-extent of the eye at the threshold
const FALL_DROP = 9.5;     // world-units the camera falls into it
const FLASH_GAIN = 2.6;    // peak additive energy of the whiteout

/* the beats, in p */
const ARM_AT = 0.15;       // media is fetched here and NOWHERE earlier
const THRESHOLD = 0.72;    // the flash peaks
const CUT = 0.728;         // …and the world goes, under it

/* the tail: it runs half a turn past the last memory and comes home to
   the axis. Tip radius 0.9 — see the geometry note in the header. */
const TAIL_SPAN = 0.5;
const TAIL_SAMPLES = 56;
const TAIL_SEGMENTS = 120;
const TAIL_RADIUS = 0.05;
const TAIL_TIP_RADIUS = 0.9;
const TAIL_STRAIGHTEN = 0.88;   // how far the winding unwinds by the tip

/* card exit: lifted, pulled a touch inward, shrunk, gone by p ≈ 0.6 */
const CARD_LIFT = 2.6;
const CARD_INWARD = 1.1;
const CARD_SHRINK = 0.28;
const CARD_FADE_IN_AT = 0.05;
const CARD_FADE_OVER = 0.55;

/* the void opening, then closing over what is left of the world */
const FOG_NEAR_PUSH = 10;
const FOG_FAR_PUSH = 46;
const FOG_NEAR_COLLAPSE = 28;
const FOG_FAR_COLLAPSE = 90;
const STAR_BOOST = 0.55;
const BEYOND_STAR_BOOST = 0.45;

/* the camera */
const DRIFT_DOWN = 2.2;    // the early drift, before the fall proper
const CAM_BACK = 1.6;      // …and a step back as the life recedes
const PULL_IN = 4.8;       // then in toward the axis, into the light
const LEAN = 0.30;         // rad of forward pitch at the threshold

/* Where the aperture hangs: this far below the camera, on the axis. The
   pair is set against the lens, not by feel — at 25.6 out with a 46.8°
   lens the half-frame subtends 23.4°, so 10.6 below puts the opening eye
   just inside the bottom edge, and the lean walks it to dead centre by
   the threshold. It also has to land ON the tail's tip (helix y = −45 +
   30·smooth, i.e. −15 → −11.4 in world), which it does from p ≈ 0.4 on —
   before the tip's own light ever ignites. */
const AHEAD_FAR = 10.6;
const AHEAD_NEAR = 7.2;

/* the cascade's fall box, in world units around the camera */
const BOX_H = 46;
const BOX_X = 20;
const BOX_Z_FRONT = 34;    // in front of the lens (the camera looks −z)
const BOX_Z_BACK = 6;

/* the line */
const LINE_AT = 0.80;
const LINE_OVER = 0.17;

const VIDEO_READY_MS = 1200;   // canplay must land inside this, or stills

const DEEP_VOID = new THREE.Color('#0A0B18');

const SPARK_URL = 'assets/textures/spark-point.png';
const RAYS_URL = 'assets/textures/light-rays.png';
const NEBULA_URL = 'assets/textures/nebula-warm.png';
const SHAFTS_URL = 'assets/video-tex/light-shafts.mp4';
const CHURN_URL = 'assets/video-tex/nebula-churn.mp4';

/* Tier scaling. The aperture's layer count is the real dial: base draws
   the eye, the rays and one halo; mid adds the ring shells; high adds a
   very faint outer halo that exists only to seed bloom in the air. */
const TIERS = {
  base: { motes: 90, stream: 60, cascade: 120, layers: 3 },
  mid: { motes: 180, stream: 140, cascade: 300, layers: 4 },
  high: { motes: 280, stream: 220, cascade: 500, layers: 5 },
};

/* kind: 0 core · 1 rings · 2 rays · 3 halo (see outro.glsl.js).
   Ordered so the first N are the right N for every tier. */
const AP_LAYERS = [
  { kind: 0, scale: 1.00, gain: 1.00, phase: 0.0 },
  { kind: 2, scale: 2.60, gain: 0.62, phase: 1.7 },
  { kind: 3, scale: 3.50, gain: 0.34, phase: 0.0 },
  { kind: 1, scale: 1.62, gain: 0.70, phase: 0.9 },
  { kind: 3, scale: 5.40, gain: 0.13, phase: 0.0 },
];

/* ------------------------------------------------------------------ */
/* small pure helpers                                                  */
/* ------------------------------------------------------------------ */

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function smoothstep01(v) {
  return v * v * (3 - 2 * v);
}

/* the one shape every beat is cut with: 0 before a, 1 after b, eased */
function ramp(p, a, b) {
  return smoothstep01(clamp01((p - a) / (b - a)));
}

/* ------------------------------------------------------------------ */
/* geometry builders                                                   */
/* ------------------------------------------------------------------ */

/* The tail: sampled off helixAt for continuity at t = 1 (position AND
   tangent — the unwind uses u², whose derivative is 0 at the join), then
   allowed to unwind off the helix and converge onto the axis. The thread
   stops being a life and becomes a fall into the light. */
function buildTailGeometry() {
  const base = helixAt(OUTRO_START);
  const points = [];
  for (let i = 0; i <= TAIL_SAMPLES; i += 1) {
    const u = i / TAIL_SAMPLES;
    const h = helixAt(OUTRO_START + u * TAIL_SPAN);
    const straighten = u * u;
    const angle = base.angle
      + (h.angle - base.angle) * (1 - straighten * TAIL_STRAIGHTEN);
    const radius = THREAD_RADIUS
      + (TAIL_TIP_RADIUS - THREAD_RADIUS) * straighten;
    points.push(new THREE.Vector3(
      Math.sin(angle) * radius,
      h.y,
      Math.cos(angle) * radius,
    ));
  }
  return new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(points),
    TAIL_SEGMENTS, TAIL_RADIUS, 6, false,
  );
}

/* The aperture: N quads, ONE geometry, one draw call. Corners are ±1 so
   the shader's r = 1 is exactly aScale · uRadius world units. */
function buildApertureGeometry(layers) {
  const n = layers.length;
  const position = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const quad = new Float32Array(n * 4 * 4);
  const index = new Uint16Array(n * 6);
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const UVS = [[0, 0], [1, 0], [1, 1], [0, 1]];

  for (let i = 0; i < n; i += 1) {
    const layer = layers[i];
    for (let j = 0; j < 4; j += 1) {
      const v = i * 4 + j;
      position[v * 3] = CORNERS[j][0];
      position[v * 3 + 1] = CORNERS[j][1];
      position[v * 3 + 2] = 0;
      uv[v * 2] = UVS[j][0];
      uv[v * 2 + 1] = UVS[j][1];
      quad[v * 4] = layer.kind;
      quad[v * 4 + 1] = layer.scale;
      quad[v * 4 + 2] = layer.gain;
      quad[v * 4 + 3] = layer.phase;
    }
    const o = i * 4;
    index[i * 6] = o;
    index[i * 6 + 1] = o + 1;
    index[i * 6 + 2] = o + 2;
    index[i * 6 + 3] = o;
    index[i * 6 + 4] = o + 2;
    index[i * 6 + 5] = o + 3;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aQuad', new THREE.BufferAttribute(quad, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/* The motes: born across the face of the last photograph, each carrying
   the uv it was born at so the shader can fetch its own pixel. */
function buildMoteGeometry(count, halfW, halfH) {
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    const x = (Math.random() * 2 - 1) * halfW;
    const y = (Math.random() * 2 - 1) * halfH;
    position[i * 3] = x;
    position[i * 3 + 1] = y;
    position[i * 3 + 2] = (Math.random() * 2 - 1) * 0.03;
    uv[i * 2] = x / (halfW * 2) + 0.5;
    uv[i * 2 + 1] = y / (halfH * 2) + 0.5;
    seed[i * 4] = Math.random();
    seed[i * 4 + 1] = Math.random();
    seed[i * 4 + 2] = Math.random();
    seed[i * 4 + 3] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geometry.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/* The stream: `position` is an approach DIRECTION, flattened in y so the
   inflow reads as a disc of falling dust rather than a sphere. */
function buildStreamGeometry(count) {
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const u = Math.random() * 2 - 1;
    const az = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    position[i * 3] = s * Math.cos(az);
    position[i * 3 + 1] = u * 0.45;
    position[i * 3 + 2] = s * Math.sin(az);
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

/* The cascade: a box around the camera, biased in front of the lens. */
function buildCascadeGeometry(count) {
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    position[i * 3] = (Math.random() * 2 - 1) * BOX_X;
    position[i * 3 + 1] = (Math.random() * 2 - 1) * (BOX_H / 2);
    position[i * 3 + 2] = BOX_Z_BACK - Math.random() * (BOX_Z_FRONT + BOX_Z_BACK);
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

/* A white 1×1, bound from frame one so no sampler is EVER unbound (the
   discipline js/core.js and js/spiral.js both keep). */
function whitePixel() {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/* The inert stand-in: the exact shape the caller expects, doing nothing. */
function inertOutro() {
  return {
    update() {},
    release() {},
    progress() { return 0; },
    end: OUTRO_END,
  };
}

/* initOutro({ camera, scene, spiral, thread, particles })
   → { update(TIMELINE, frame, dt), release(), progress(), end }

   `frame` is the era-ledger frame app.js just applied — the outro reads
   the base fog/background/tint off it and writes offsets, so nothing
   accumulates. `thread` is not driven directly: past smooth = 1 its own
   uProgress leaves it fully lit with the pulse already off its end, which
   is exactly where this tail picks the light up. */
export function initOutro(options = {}) {
  try {
    return buildOutro(options) || inertOutro();
  } catch (err) {
    return inertOutro();
  }
}

function buildOutro({ camera, scene, spiral, thread, particles } = {}) {
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionScale = reduced ? 0.35 : 1;
  /* Reduced motion never gets a strike of white — the same energy is
     spread over twice the reach and a third of the peak, so the frame
     lifts and settles instead of flashing. */
  const flashGain = reduced ? 0.9 : FLASH_GAIN;
  const flashSigma = reduced ? 0.11 : 0.055;

  const cards = (spiral && spiral.cards) || [];
  const memories = (spiral && spiral.memories) || [];
  const lastCard = cards.length ? cards[cards.length - 1] : null;

  /* The card's helix home, read ONCE — helixAt is the single source of
     truth, and focus.js computes the very same values for its sessions. */
  const home = lastCard ? helixAt(lastCard.userData.t) : helixAt(1);
  const homePos = new THREE.Vector3(
    Math.sin(home.angle) * home.radius,
    home.y,
    Math.cos(home.angle) * home.radius,
  );
  /* Radial unit vector at that angle — "inward" is −radial. */
  const radial = new THREE.Vector2(Math.sin(home.angle), Math.cos(home.angle));

  /* Tier: the resolved object boot.js parked on the flags, or — if a test
     started app.js directly — the particle census as a fingerprint
     (base 490 · mid 810 · high 1120 points at build time). */
  const tier = (() => {
    try {
      const flags = typeof window !== 'undefined' ? window.OMR_FLAGS : null;
      const name = flags && flags.quality && flags.quality.name;
      if (name && TIERS[name]) return TIERS[name];
    } catch (err) { /* no window, no flags — the census answers */ }
    const n = particles && Number.isFinite(particles.count) ? particles.count : 0;
    if (n > 0 && n < 620) return TIERS.base;
    if (n >= 980) return TIERS.high;
    return TIERS.mid;
  })();

  /* ---------------- the line (built first, and unconditionally) -------
     Every GL ornament below is optional; the words are not. */
  const block = document.createElement('div');
  block.id = 'outro';
  block.setAttribute('aria-hidden', 'true');

  const line = document.createElement('div');
  line.className = 'ou-line';
  line.textContent = 'to be continued —';

  const meta = document.createElement('div');
  meta.className = 'ou-meta';
  const yearEl = document.createElement('span');
  yearEl.className = 'ou-year';
  const lastMemory = memories.length ? memories[memories.length - 1] : null;
  yearEl.textContent = String((lastMemory && lastMemory.year) || '');
  const rule = document.createElement('span');
  rule.className = 'ou-rule';
  const arEl = document.createElement('span');
  arEl.className = 'ou-ar';
  arEl.lang = 'ar';
  arEl.dir = 'rtl';
  arEl.textContent = 'عُمر';
  meta.append(yearEl, rule, arEl);

  block.append(line, meta);
  document.body.appendChild(block);

  /* ---------------- the ornaments -------------------------------------
     One try/catch around the whole GL build: a failure anywhere leaves
     `stage` null and the ending degrades to the camera fall, the opening
     void and the words — which still reads, and still never throws. */
  const state = { armed: false, stillsAsked: false, disposed: false, plates: [] };
  let stage = null;
  try {
    stage = buildStage({ scene, spiral, tier, reduced });
  } catch (err) {
    stage = null;
  }

  /* ---------------- media: nothing is fetched until p > 0.15 ---------- */
  const loader = new THREE.TextureLoader();

  /* A slot is one sampler + its "have I got anything" flag, and the three
     things that could be in it, in order of preference. bind() is the
     only writer, so the clip arriving late, the still arriving late, and
     the clip being dropped all resolve through ONE rule. */
  function makeSlot(texU, hasU, aspectU, blank) {
    return {
      tex: texU, has: hasU, aspect: aspectU, blank,
      still: null, stillAspect: 1,
      video: null, videoAspect: 1,
      el: null, timer: 0,
    };
  }
  function bind(rec) {
    if (!rec) return;
    if (rec.video) {
      rec.tex.value = rec.video;
      rec.has.value = 1;
      if (rec.aspect) rec.aspect.value = rec.videoAspect;
    } else if (rec.still) {
      rec.tex.value = rec.still;
      rec.has.value = 1;
      if (rec.aspect) rec.aspect.value = rec.stillAspect;
    } else {
      rec.tex.value = rec.blank;
      rec.has.value = 0;
    }
  }

  const slots = stage ? {
    spark: makeSlot(stage.spriteU.uSprite, stage.spriteU.uHasSprite, null, stage.blank),
    rays: makeSlot(stage.apU.uRays, stage.apU.uHasRays, null, stage.blank),
    nebula: makeSlot(stage.bdU.uNebula, stage.bdU.uHasNebula,
      stage.bdU.uTexAspect, stage.blank),
  } : null;

  /* ONE silent HEAD per asset. A 404 is a normal answer here, never an
     error: nothing is logged, and TextureLoader only ever runs against a
     URL the probe confirmed, so three cannot log either. */
  function probe(url) {
    try {
      if (typeof fetch !== 'function') return Promise.resolve(false);
      return fetch(url, { method: 'HEAD' })
        .then((res) => !!res && !!res.ok)
        .catch(() => false);
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  function loadStill(url, rec, colorSpace) {
    if (!rec) return;
    probe(url).then((ok) => {
      if (!ok || state.disposed) return;
      loader.load(url, (tex) => {
        if (state.disposed) { tex.dispose(); return; }
        tex.colorSpace = colorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        const img = tex.image;
        rec.stillAspect = img && img.height ? img.width / img.height : 1;
        rec.still = tex;
        state.plates.push(tex);
        bind(rec);
      }, undefined, () => { /* probed yes, decoded no — stay procedural */ });
    }).catch(() => {});
  }

  /* ONE <video> per clip, created here and nowhere else. If canplay has
     not landed inside VIDEO_READY_MS the element is dropped and the slot
     falls straight back to the still — the ending never waits on media
     and never goes black because of it. */
  function armClip(url, rec) {
    if (!rec || rec.el || state.disposed) return;
    let el;
    try {
      el = document.createElement('video');
    } catch (err) {
      return;
    }
    el.muted = true;
    el.defaultMuted = true;
    el.loop = true;
    el.playsInline = true;
    el.setAttribute('muted', '');
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    rec.el = el;
    rec.timer = setTimeout(() => { dropClip(rec); }, VIDEO_READY_MS);
    el.addEventListener('canplay', () => {
      /* the zone may have been left, or the watchdog may have fired,
         before the decoder was ever ready */
      if (state.disposed || rec.el !== el) return;
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
      let tex;
      try {
        tex = new THREE.VideoTexture(el);
      } catch (err) {
        dropClip(rec);
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      rec.video = tex;
      rec.videoAspect = el.videoWidth && el.videoHeight
        ? el.videoWidth / el.videoHeight
        : rec.stillAspect;
      bind(rec);
      el.playbackRate = 0.75;   // everything out here is calm
      const play = el.play();
      if (play && play.catch) play.catch(() => {});
    }, { once: true });
    el.addEventListener('error', () => { dropClip(rec); }, { once: true });
    el.src = url;
    try {
      el.load();
    } catch (err) { /* the still is already the answer */ }
  }

  function dropClip(rec) {
    if (!rec) return;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
    if (rec.video) { rec.video.dispose(); rec.video = null; }
    const el = rec.el;
    rec.el = null;
    if (el) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();          // release the decoder AND the network slot
      } catch (err) { /* already gone */ }
    }
    bind(rec);
  }

  function armMedia() {
    if (!slots || state.armed || state.disposed) return;
    state.armed = true;
    if (!state.stillsAsked) {
      state.stillsAsked = true;
      /* intensity data, not colour, for the two the shaders shape */
      loadStill(SPARK_URL, slots.spark, THREE.NoColorSpace);
      loadStill(RAYS_URL, slots.rays, THREE.NoColorSpace);
      loadStill(NEBULA_URL, slots.nebula, THREE.SRGBColorSpace);
    }
    armClip(SHAFTS_URL, slots.rays);
    armClip(CHURN_URL, slots.nebula);
  }

  function disarmMedia() {
    if (!slots || !state.armed) return;
    state.armed = false;
    dropClip(slots.rays);
    dropClip(slots.nebula);
  }

  /* ---------------- state (one flag, one cached DOM value) ------------ */
  let released = true;
  let failed = false;
  let lastOpacity = -1;
  let lastP = 0;
  let clock = 3.17;          // ambient phase only — never a beat

  /* scratch, allocated once */
  const anchor = new THREE.Vector3();
  const viewPoint = new THREE.Vector3();
  const camInverse = new THREE.Matrix4();
  const camDir = new THREE.Vector3();

  function setLine(o) {
    if (Math.abs(o - lastOpacity) < 0.004) return;
    lastOpacity = o;
    block.style.opacity = o.toFixed(3);
    block.style.visibility = o > 0.001 ? 'visible' : 'hidden';
  }

  function hideStage() {
    if (!stage) return;
    for (let i = 0; i < stage.meshes.length; i += 1) {
      stage.meshes[i].visible = false;
    }
  }

  /* Hand everything back — runs on the ONE frame the outro zone is left. */
  function release() {
    released = true;
    if (lastCard) {
      lastCard.position.copy(homePos);
      lastCard.scale.set(1, 1, 1);
      lastCard.visible = true;
      const uFade = lastCard.userData.uFade;
      if (uFade) uFade.value = 1;
    }
    if (spiral && spiral.group) spiral.group.visible = true;
    hideStage();
    if (particles && particles.setSkyBoost) particles.setSkyBoost(0);
    setLine(0);
    disarmMedia();
  }

  /* ---------------- per-frame ----------------------------------------- */
  function drive(TIMELINE, frame, dt) {
    /* A missing or NaN clock reads as "not in the zone" rather than as a
       throw — one bad frame must never stand the ending down. */
    const smooth = TIMELINE && Number.isFinite(TIMELINE.smooth)
      ? TIMELINE.smooth : 0;
    const p = clamp01((smooth - OUTRO_START) / SPAN);
    lastP = p;

    if (p <= 0) {
      if (!released) release();
      return;
    }
    released = false;
    if (p > ARM_AT) armMedia();

    const step = Math.min(Math.max(dt || 0, 0), 0.05);
    clock += step * motionScale;

    /* ---- every beat, as a pure function of p ---- */
    const e = smoothstep01(p);
    /* While focus has a card staged it owns every card transform, and the
       world may not be switched off underneath the reticle. */
    const staged = document.body.classList.contains('focus-open');

    const dissolve = ramp(p, 0.02, 0.52);          // the motes' flight
    const moteIn = ramp(p, 0.01, 0.12);
    const moteOut = ramp(p, 0.34, 0.58);
    const tailIn = ramp(p, 0.02, 0.30);
    const tailOut = ramp(p, 0.60, 0.73);
    const apIn = ramp(p, 0.20, 0.36);
    const apOut = ramp(p, 0.72, 0.82);
    const apGrow = ramp(p, 0.20, 0.70);
    const pupil = ramp(p, 0.50, 0.76);
    const fall = Math.pow(ramp(p, 0.45, 0.86), 1.3);   // weight: slow, then it goes
    const lean = ramp(p, 0.24, 0.85);
    const swallow = staged ? 0 : ramp(p, 0.58, 0.74);
    const beyond = ramp(p, 0.68, 0.84);
    const words = ramp(p, LINE_AT, LINE_AT + LINE_OVER);

    const fd = (p - THRESHOLD) / flashSigma;
    const flash = Math.exp(-fd * fd);

    const apOpacity = apIn * (1 - apOut);
    const apRadius = 0.12 + APERTURE_R * Math.pow(apGrow, 1.6) * (1 + 0.40 * flash);

    /* ---- the last card leaves ---- */
    if (lastCard) {
      const uFade = lastCard.userData.uFade;
      if (staged) {
        if (uFade) uFade.value = 1;
        lastCard.visible = true;
        lastCard.scale.set(1, 1, 1);
      } else {
        const fade = 1 - smoothstep01(
          clamp01((p - CARD_FADE_IN_AT) / CARD_FADE_OVER));
        lastCard.position.set(
          homePos.x - radial.x * CARD_INWARD * e,
          homePos.y + CARD_LIFT * e,
          homePos.z - radial.y * CARD_INWARD * e,
        );
        const s = 1 - CARD_SHRINK * e;
        lastCard.scale.set(s, s, s);
        if (uFade) uFade.value = fade;
        /* Below a whisper it stops drawing entirely: transparent cards
           still write depth, and an invisible one must not occlude the
           tail or the aperture passing behind it. */
        lastCard.visible = fade > 0.02;
      }
    }

    /* ---- the camera falls (before the anchor: it hangs off this pose) ---- */
    if (camera) {
      camera.position.y -= DRIFT_DOWN * e + FALL_DROP * fall;
      camera.position.z += CAM_BACK * e - PULL_IN * fall;
      if (lean > 0) camera.rotateX(-LEAN * lean);
    }

    /* ---- the void opens, then closes over what is left of the world ---- */
    if (scene && scene.fog && frame && frame.world) {
      scene.fog.near = frame.world.fogNear + FOG_NEAR_PUSH * e
        - FOG_NEAR_COLLAPSE * swallow;
      scene.fog.far = frame.world.fogFar + FOG_FAR_PUSH * e
        - FOG_FAR_COLLAPSE * swallow;
    }
    if (scene && scene.background && scene.background.isColor) {
      scene.background.lerp(DEEP_VOID, Math.min(0.95, 0.55 * e + 0.40 * beyond));
    }
    if (particles && particles.setSkyBoost) {
      particles.setSkyBoost(STAR_BOOST * e + BEYOND_STAR_BOOST * beyond);
    }

    /* ---- THE CUT: the world goes, under the white ---- */
    if (spiral && spiral.group) {
      spiral.group.visible = staged ? true : p <= CUT;
    }

    setLine(words);
    if (!stage) return;

    /* ---- the tail: the thread continuing into the light ---- */
    const tailOpacity = tailIn * (1 - tailOut);
    stage.tail.visible = tailOpacity > 0.002;
    if (stage.tail.visible) {
      /* The LEADING PULSE is timed to reach the tip on exactly the frame
         the threshold peaks (uHead = 1 at p = THRESHOLD): the last of the
         light arriving is what blows the frame out. */
      stage.tailU.uTime.value = clock;
      stage.tailU.uHead.value = p / THRESHOLD;
      stage.tailU.uOpacity.value = tailOpacity;
      stage.tailU.uFeed.value = ramp(p, 0.35, 0.72);
    }

    /* ---- the photograph comes apart ---- */
    if (stage.motes) {
      const moteOpacity = staged ? 0 : moteIn * (1 - moteOut);
      stage.motes.visible = moteOpacity > 0.002;
      if (stage.motes.visible) {
        stage.moteU.uTime.value = clock;
        stage.moteU.uP.value = dissolve;
        stage.moteU.uOpacity.value = moteOpacity;
        if (frame && frame.world && frame.world.eraTint) {
          stage.moteU.uTint.value.copy(frame.world.eraTint);
        }
      }
    }

    /* ---- the aperture, on the axis below ---- */
    anchor.set(0, (camera ? camera.position.y : 0)
      - (AHEAD_FAR + (AHEAD_NEAR - AHEAD_FAR) * ramp(p, 0.20, 0.78)), 0);

    stage.aperture.visible = apOpacity > 0.002;
    if (stage.aperture.visible) {
      stage.apU.uAnchor.value.copy(anchor);
      stage.apU.uRadius.value = apRadius;
      stage.apU.uTime.value = clock;
      stage.apU.uOpacity.value = apOpacity;
      stage.apU.uOpen.value = pupil;
      stage.apU.uCa.value = 0.006 + 0.055 * ramp(p, 0.45, 0.78);
      if (frame && frame.world && frame.world.eraTint) {
        stage.apU.uTint.value.copy(frame.world.eraTint);
      }
    }

    /* ---- dust falling into it ---- */
    if (stage.stream) {
      const streamOpacity = apOpacity * (0.35 + 0.65 * apGrow);
      stage.stream.visible = streamOpacity > 0.002;
      if (stage.stream.visible) {
        stage.stream.position.copy(anchor);
        stage.streamU.uTime.value = clock;
        stage.streamU.uOpacity.value = streamOpacity;
        stage.streamU.uOuter.value = apRadius * 5.5;
        stage.streamU.uInner.value = apRadius * 0.5;
      }
    }

    /* ---- BEYOND: the deep field and the cascade ---- */
    stage.backdrop.visible = beyond > 0.002;
    if (stage.backdrop.visible) {
      stage.bdU.uTime.value = clock;
      /* The field blazes in, then settles back as the words arrive: the
         ending should end on the sentence, not on the spectacle. Pure
         f(p) — smoothstep over the same window the text fades in on — so
         scrolling back up brightens it again exactly. */
      const settle = 1 - 0.42 * ramp(p, 0.78, 0.95);
      stage.bdU.uOpacity.value = beyond * settle;
      stage.bdU.uZoom.value = 1 + 0.07 * beyond;
      stage.bdU.uAspect.value = camera && camera.aspect ? camera.aspect : 1.6;
      if (camera) {
        /* parallax from where the eye is actually pointed — small, and a
           pure function of the pose, which is a pure function of p */
        camera.getWorldDirection(camDir);
        stage.bdU.uPan.value.set(camDir.x * 0.05, camDir.y * 0.06);
      }
      if (frame && frame.world && frame.world.eraTint) {
        stage.bdU.uTint.value.copy(frame.world.eraTint);
      }
    }

    if (stage.cascade) {
      stage.cascade.visible = beyond > 0.002;
      if (stage.cascade.visible) {
        if (camera) stage.cascade.position.copy(camera.position);
        stage.cascadeU.uTime.value = clock;
        stage.cascadeU.uOpacity.value = beyond;
      }
    }

    /* ---- THE THRESHOLD ---- */
    stage.flash.visible = flash > 0.002;
    if (stage.flash.visible) {
      stage.flashU.uFlash.value = flash * flashGain;
      stage.flashU.uAspect.value = camera && camera.aspect ? camera.aspect : 1.6;
      /* the white blooms from where the aperture IS, not from the middle
         of the screen — one projection, no allocation, and only while the
         flash is actually on screen */
      if (camera) {
        camera.updateMatrixWorld();
        camInverse.copy(camera.matrixWorld).invert();
        viewPoint.copy(anchor).applyMatrix4(camInverse);
        if (viewPoint.z < -0.1) {
          viewPoint.applyMatrix4(camera.projectionMatrix);
          stage.flashU.uCenter.value.set(
            Math.max(-1.6, Math.min(1.6, viewPoint.x)),
            Math.max(-1.6, Math.min(1.6, viewPoint.y)),
          );
        }
      }
    }
  }

  /* The frame loop must never be the thing that takes the site down: one
     throw hands the world back and stands the ending down for good. */
  function update(TIMELINE, frame, dt) {
    if (failed) return;
    try {
      drive(TIMELINE, frame, dt);
    } catch (err) {
      failed = true;
      try {
        release();
      } catch (inner) { /* nothing left to hand back */ }
    }
  }

  return {
    update,
    release,
    progress() {
      return lastP;
    },
    end: OUTRO_END,
  };
}

/* ------------------------------------------------------------------ */
/* the stage: every GL ornament, built once                            */
/* ------------------------------------------------------------------ */

function buildStage({ scene, spiral, tier, reduced }) {
  if (!scene || typeof scene.add !== 'function') return null;
  if (!spiral || !spiral.group) return null;

  const meshes = [];
  const blank = whitePixel();
  const pixelRatio = Math.min(
    (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1, 2);

  /* Shared by all three point programs — ONE write when the sprite
     arrives reaches the motes, the stream and the cascade at once. */
  const spriteU = {
    uSprite: { value: blank },
    uHasSprite: { value: 0 },
  };

  /* `defines` is omitted rather than passed as undefined: three's
     Material.setValues console.warns on any undefined parameter, and this
     module is not allowed to make noise. */
  function pointMaterial(vertexShader, uniforms, defines) {
    const params = {
      vertexShader,
      fragmentShader: outroSpriteFragment,
      uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    };
    if (defines) params.defines = defines;
    return new THREE.ShaderMaterial(params);
  }

  /* ---- the tail ------------------------------------------------------ */
  const tailGeo = buildTailGeometry();
  const tailU = {
    uTime: { value: 3.17 },
    uHead: { value: 0 },
    uOpacity: { value: 0 },
    uFeed: { value: 0 },
    /* fogColor is never read; it exists because fog:true makes the
       renderer refresh all three from scene.fog (see js/thread.js). */
    fogColor: { value: new THREE.Color('#2A2140') },
    fogNear: { value: 30 },
    fogFar: { value: 76 },
  };
  const tail = new THREE.Mesh(tailGeo, new THREE.ShaderMaterial({
    vertexShader: outroTailVertex,
    fragmentShader: outroTailFragment,
    uniforms: tailU,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: true,
  }));
  tail.renderOrder = 1;          // with the thread: after the cards
  tail.frustumCulled = false;
  tail.visible = false;
  spiral.group.add(tail);
  meshes.push(tail);

  /* ---- the motes: the photograph coming apart ------------------------ */
  let motes = null;
  let moteU = null;
  const cards = spiral.cards || [];
  const lastCard = cards.length ? cards[cards.length - 1] : null;
  if (lastCard && lastCard.material && lastCard.material.uniforms) {
    const u = lastCard.material.uniforms;
    /* the card's own sizing rule, read off the card — never re-derived */
    const halfW = u.uCardHalfW && Number.isFinite(u.uCardHalfW.value)
      ? u.uCardHalfW.value : 1.6;
    const aspect = u.uCardAspect && u.uCardAspect.value ? u.uCardAspect.value : 0.762;
    const halfH = halfW / aspect;
    const home = helixAt(lastCard.userData.t);
    moteU = {
      uTime: { value: 3.17 },
      uP: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      /* the card's LIVE texture slot, by reference: it can never be
         unbound, and an eviction swaps both at once (js/textures.js) */
      uMap: u.uMap,
      uTint: { value: new THREE.Color('#FFE9C4') },
      uSprite: spriteU.uSprite,
      uHasSprite: spriteU.uHasSprite,
    };
    motes = new THREE.Points(
      buildMoteGeometry(tier.motes, halfW, halfH),
      pointMaterial(outroMoteVertex, moteU),
    );
    motes.position.set(
      Math.sin(home.angle) * home.radius,
      home.y,
      Math.cos(home.angle) * home.radius,
    );
    /* the card's own yaw, so "inward" in the shader really is inward */
    motes.rotation.y = home.angle;
    motes.renderOrder = 2;
    motes.frustumCulled = false;
    motes.visible = false;
    spiral.group.add(motes);
    meshes.push(motes);
  }

  /* ---- the aperture -------------------------------------------------- */
  const layers = AP_LAYERS.slice(0, Math.max(1, tier.layers));
  const apU = {
    uTime: { value: 3.17 },
    uOpacity: { value: 0 },
    uOpen: { value: 0 },
    uCa: { value: 0.006 },
    uGain: { value: 1 },
    uRadius: { value: 0.12 },
    uAnchor: { value: new THREE.Vector3(0, -12, 0) },
    uRays: { value: blank },
    uHasRays: { value: 0 },
    uTint: { value: new THREE.Color('#F4EFE6') },
  };
  const aperture = new THREE.Mesh(
    buildApertureGeometry(layers),
    new THREE.ShaderMaterial({
      vertexShader: outroApertureVertex,
      fragmentShader: outroApertureFragment,
      uniforms: apU,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      /* depth TEST stays on: a card passing in front still occludes the
         light correctly, exactly as it does for the pillar. */
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  aperture.renderOrder = 3;
  aperture.frustumCulled = false;   // the anchor lives in a uniform
  aperture.visible = false;
  scene.add(aperture);
  meshes.push(aperture);

  /* ---- the inflow ---------------------------------------------------- */
  let stream = null;
  let streamU = null;
  if (tier.stream > 0) {
    streamU = {
      uTime: { value: 3.17 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uOuter: { value: 12 },
      uInner: { value: 1 },
      uSprite: spriteU.uSprite,
      uHasSprite: spriteU.uHasSprite,
    };
    stream = new THREE.Points(
      buildStreamGeometry(tier.stream),
      pointMaterial(outroStreamVertex, streamU),
    );
    stream.renderOrder = 3;
    stream.frustumCulled = false;
    stream.visible = false;
    scene.add(stream);
    meshes.push(stream);
  }

  /* ---- the cascade --------------------------------------------------- */
  let cascade = null;
  let cascadeU = null;
  if (tier.cascade > 0) {
    cascadeU = {
      uTime: { value: 3.17 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uRate: { value: reduced ? 0.45 : 1 },
      uSprite: spriteU.uSprite,
      uHasSprite: spriteU.uHasSprite,
    };
    cascade = new THREE.Points(
      buildCascadeGeometry(tier.cascade),
      pointMaterial(outroCascadeVertex, cascadeU, {
        BOX_H: BOX_H.toFixed(1),
        BOX_HALF_H: (BOX_H / 2).toFixed(1),
        BOX_FADE: (BOX_H / 2 - BOX_H * 0.18).toFixed(1),
      }),
    );
    cascade.renderOrder = 3;
    cascade.frustumCulled = false;   // it is anchored to the camera
    cascade.visible = false;
    scene.add(cascade);
    meshes.push(cascade);
  }

  /* ---- the deep field ------------------------------------------------ */
  const screenGeo = new THREE.PlaneGeometry(2, 2);
  const bdU = {
    uNebula: { value: blank },
    uHasNebula: { value: 0 },
    uTexAspect: { value: 1.777 },
    uAspect: { value: 1.6 },
    uPan: { value: new THREE.Vector2(0, 0) },
    uZoom: { value: 1 },
    uOpacity: { value: 0 },
    uTime: { value: 3.17 },
    uTint: { value: new THREE.Color('#F4EFE6') },
  };
  const backdrop = new THREE.Mesh(screenGeo, new THREE.ShaderMaterial({
    vertexShader: outroScreenVertex,
    fragmentShader: outroBackdropFragment,
    uniforms: bdU,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  backdrop.renderOrder = -1000;    // before the nebulae and the stars
  backdrop.frustumCulled = false;
  backdrop.visible = false;
  scene.add(backdrop);
  meshes.push(backdrop);

  /* ---- the threshold ------------------------------------------------- */
  const flashU = {
    uFlash: { value: 0 },
    uCenter: { value: new THREE.Vector2(0, -0.3) },
    uAspect: { value: 1.6 },
  };
  const flash = new THREE.Mesh(screenGeo, new THREE.ShaderMaterial({
    vertexShader: outroScreenVertex,
    fragmentShader: outroFlashFragment,
    uniforms: flashU,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  /* Over every other thing in the scene — that is the entire job. The
     DOM words live above the canvas and are never touched by it. */
  flash.renderOrder = 999;
  flash.frustumCulled = false;
  flash.visible = false;
  scene.add(flash);
  meshes.push(flash);

  return {
    meshes, blank, spriteU,
    tail, tailU,
    motes, moteU,
    aperture, apU,
    stream, streamU,
    cascade, cascadeU,
    backdrop, bdU,
    flash, flashU,
  };
}
