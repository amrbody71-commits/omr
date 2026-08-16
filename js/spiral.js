/* spiral.js — the descending helix of memory cards.
   helixAt(t) is the single source of truth for the curve; every unit that
   places anything on the spiral must go through it.

   U3: cards are glass-lantern ShaderMaterials (js/shaders/card.glsl.js) —
   one compiled program for all 14 (identical source + defines hit three's
   program cache), one material INSTANCE per card whose shared uniforms
   (uTime / uVelocity / uEraTint / uFocus / uPointer / uBreathe) point at
   the SAME objects — one write per frame reaches every card. Textures come
   from the js/textures.js window manager. The shader is self-lit: no scene
   lights, no tint-multiply. */

import * as THREE from 'three';
import { cardVertex, cardFragment } from './shaders/card.glsl.js';
import { initTextures } from './textures.js';

export const TURNS = 2.5;    // full revolutions over a lifetime (14 cards)
export const HEIGHT = 30;    // world-units of DESCENT, t=0 → t=1
export const RADIUS = 14;    // world-units from the axis

const TWO_PI = Math.PI * 2;

/* t ∈ [0,1] → position on the helix.
   The spiral DESCENDS like the reference reel: birth (t=0) is at the top,
   NOW (t=1) at the bottom — y runs negative as t grows. */
export function helixAt(t) {
  return {
    angle: t * TURNS * TWO_PI,
    y: -t * HEIGHT,
    radius: RADIUS,
  };
}

const CARD_W = 3.2;
const CARD_H = 4.2;
/* Default plane subdivision — the mid/high tier value (24×32 × 14 cards
   ≈ 10.7k quads); the base tier passes 12×16 via quality.cardSubdiv. */
const SEG_X = 24;
const SEG_Y = 32;

/* uVelocity smoothing on the combined (scroll + drag) angular velocity. */
const VEL_LAMBDA = 8;

/* Builds the spiral group from data/memories.json and adds it to the scene.
   `quality` (js/quality.js tier object) sets card subdivision and the
   texture residency window. Returns { group, eras, memories,
   update(TIMELINE, dt, pointer), setEraTint(color), stats() }. */
export async function createSpiral(scene, { renderer, quality } = {}) {
  const res = await fetch('data/memories.json');
  if (!res.ok) throw new Error('memories.json failed to load (' + res.status + ')');
  const data = await res.json();

  /* Read once at init: reduced motion kills the breathing and clamps every
     velocity effect (bow, streaks, split) to 20%. */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionScale = reduced ? 0.2 : 1;

  /* ---- shared uniforms: ONE object each, referenced by all 14 materials —
     writing .value once per frame updates every card. -------------------- */
  const shared = {
    uTime: { value: 0 },
    uVelocity: { value: 0 },
    uEraTint: { value: new THREE.Color('#F4EFE6') },
    uFocus: { value: 0 },                    // U8 wires the focus dim
    uPointer: { value: new THREE.Vector2(0, 0) },
    uBreathe: { value: reduced ? 0 : 1 },
  };

  /* Fog uniforms, also shared by reference: the renderer refreshes their
     .value from scene.fog for each fog:true material (same values 14× —
     harmless, and the ledger's per-frame fog writes flow straight in). */
  const fogUniforms = {
    fogColor: { value: new THREE.Color('#2A2140') },
    fogNear: { value: 30 },
    fogFar: { value: 76 },
  };

  const textures = initTextures(data.memories, {
    window: quality && quality.texWindow,
    renderer,
    eras: data.eras,
  });

  const [segX, segY] = (quality && quality.cardSubdiv) || [SEG_X, SEG_Y];

  const group = new THREE.Group();
  const count = data.memories.length;
  const cards = [];

  /* Orientation-aware card sizing: the photo's aspect decides the glass.
     Longest edge is always CARD_MAX so portrait and landscape slides carry
     equal presence on the helix. Geometries are cached per rounded aspect
     (the collection has only a handful of distinct ratios). Card dims reach
     the ONE shared program as uniforms (uCardAspect/uCardHalfW), never as
     per-card defines — defines would fork a program per card. */
  const CARD_MAX = 4.35;
  const geoCache = new Map();
  function cardGeometry(aspect) {
    const key = Math.round(aspect * 50); // bucket to 0.02 steps
    if (!geoCache.has(key)) {
      const w = aspect >= 1 ? CARD_MAX : CARD_MAX * aspect;
      const h = aspect >= 1 ? CARD_MAX / aspect : CARD_MAX;
      geoCache.set(key, new THREE.PlaneGeometry(w, h, segX, segY));
    }
    return geoCache.get(key);
  }

  data.memories.forEach((memory, i) => {
    const t = count > 1 ? i / (count - 1) : 0;
    const { angle, y, radius } = helixAt(t);
    const rec = textures.acquire(i);

    /* Transparency/sort choice: transparent + depthWrite:true, default
       renderer sorting. Cards on the helix almost never overlap on screen
       except across the axis, where they are far apart in depth — the
       back-to-front transparent sort orders them correctly, and depth
       writes make any tie physically impossible. At alpha ≈ 0.96 the
       classic depthWrite-on-transparent halo is invisible; manual
       renderOrder bookkeeping would buy nothing. */
    const aspect = memory.w && memory.h ? memory.w / memory.h : CARD_W / CARD_H;
    const cardW = aspect >= 1 ? CARD_MAX : CARD_MAX * aspect;
    const cardH = aspect >= 1 ? CARD_MAX / aspect : CARD_MAX;
    const material = new THREE.ShaderMaterial({
      vertexShader: cardVertex,
      fragmentShader: cardFragment,
      uniforms: {
        /* shared — by object reference */
        uTime: shared.uTime,
        uVelocity: shared.uVelocity,
        uEraTint: shared.uEraTint,
        uFocus: shared.uFocus,
        uPointer: shared.uPointer,
        uBreathe: shared.uBreathe,
        fogColor: fogUniforms.fogColor,
        fogNear: fogUniforms.fogNear,
        fogFar: fogUniforms.fogFar,
        /* per-card — texture slots live in the window manager's record */
        uMap: rec.uMap,
        uDepth: rec.uDepth,
        uHasDepth: rec.uHasDepth,
        uReveal: rec.uReveal,
        uAspect: { value: aspect },
        uCardAspect: { value: cardW / cardH },
        uCardHalfW: { value: cardW / 2 },
        uSeed: { value: i * 2.399963 },      // golden-angle spread, no twins
        uVideoMix: { value: 0 },             // U8: photo→video mix while staged
        /* U8: focus swaps in a VideoTexture; bound to the card's own
           placeholder from frame one so the sampler is NEVER unbound. */
        uVideo: { value: rec.placeholder },
        uLit: { value: 0 },
        /* U10: per-card dissolve. Stays 1 for every card forever except
           the last one while js/outro.js plays the ending. */
        uFade: { value: 1 },
      },
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });

    const card = new THREE.Mesh(cardGeometry(aspect), material);
    // Parameterised so angle 0 sits on +Z (toward the camera).
    card.position.set(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
    // A fresh plane faces +Z; yawing it by its own helix angle points the
    // normal straight away from the Y axis — cards face OUTWARD.
    card.rotation.y = angle;
    card.userData.memory = memory;
    card.userData.t = t;
    card.userData.uLit = material.uniforms.uLit; // cached: no per-frame lookup
    card.userData.uFade = material.uniforms.uFade;   // U10 outro dissolve
    cards.push(card);
    group.add(card);
  });

  scene.add(group);

  /* uLit half-width in t: ~1.4 card spacings — the focused card reads full,
     immediate neighbours glow faintly, the rest sit into the fog. */
  const LIT_RANGE = count > 1 ? 1.4 / (count - 1) : 1;

  let prevSpin = 0;
  let velSmooth = 0;

  return {
    group,
    cards,                 // U8 focus: raycast targets (userData.memory/t/uLit)
    uFocus: shared.uFocus, // U8 focus: ONE shared dim/blur uniform, tween .value once
    eras: data.eras,
    memories: data.memories,
    stats: textures.stats,
    dispose: textures.dispose,

    /* World-moves rig: the camera never travels — the whole spiral spins and
       RISES so the camera relatively descends the helix, and the card at
       t = TIMELINE.smooth lands in front of the camera at world y ≈ 0.
       Zero allocation per frame. */
    update(TIMELINE, dt, pointer) {
      group.rotation.y = -(TIMELINE.smooth * TURNS * TWO_PI + TIMELINE.spinOffset);
      group.position.y = TIMELINE.smooth * HEIGHT;

      if (dt > 0) {
        shared.uTime.value += dt;
        /* Combined angular velocity in rad/s: the scroll descent spins the
           helix at velocity·TURNS·2π, the drag adds d(spinOffset)/dt — so
           DRAG streaks exactly like scroll does. */
        const spinVel = (TIMELINE.spinOffset - prevSpin) / dt;
        const target = TIMELINE.velocity * TURNS * TWO_PI + spinVel;
        velSmooth += (target - velSmooth) * (1 - Math.exp(-VEL_LAMBDA * dt));
        shared.uVelocity.value = velSmooth * motionScale;
      }
      prevSpin = TIMELINE.spinOffset;

      if (pointer) shared.uPointer.value.set(pointer.x, pointer.y);

      /* Per-card lit: smoothstep falloff on |cardT − smooth|. */
      for (let i = 0; i < cards.length; i += 1) {
        const d = Math.abs(cards[i].userData.t - TIMELINE.smooth);
        let lit = 1 - Math.min(1, d / LIT_RANGE);
        lit = lit * lit * (3 - 2 * lit);
        cards[i].userData.uLit.value = lit;
      }

      textures.update(TIMELINE.smooth);
    },

    /* Called by app.js with the ledger frame's interpolated era tint —
       one shared-uniform write reaches all 14 cards. */
    setEraTint(color) {
      shared.uEraTint.value.copy(color);
    },
  };
}
