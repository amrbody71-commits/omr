/* particles.js — the deep-space environment: three ambient layers that give
   the void its scale. All motion is computed IN SHADER from seeds + uTime —
   zero CPU per-frame particle work, ever.

     · FIREFLIES — warm motes drifting inside the helix volume, parented to
       spiralGroup so they ride the world rig. Ones within ~2.5 units of the
       thread's LIT portion glow 1.6× (cheap cylinder distance in-shader).
     · STARFIELD — two world-static Points shells at ~60 and ~95, beyond the
       fog (fog:false), faint ivory/gold with a cool-warm mix and slow
       twinkle. Parallax comes only from the camera's own pointer pans.
     · NEBULAE — five huge procedural billboards at radius ~48–70, merged
       into ONE geometry / ONE draw call (view-space corner offset in the
       vertex shader keeps every sprite camera-facing). fbm clouds tinted
       dusk-violet → era-warmed amber, normal blending (haze, not light),
       ≤ 9% alpha by construction.

   Shared-uniform pattern (mirrors spiral.js): every material references the
   SAME uniform objects — one write per frame reaches all layers.

   Draw calls: fireflies 1 + stars 2 + nebulae 1 = 4. */

import * as THREE from 'three';
import { RADIUS, HEIGHT } from './spiral.js';
import { THREAD_RADIUS } from './thread.js';
import {
  glslNoiseCommon, glslSnoise2, glslSnoise3,
} from './shaders/chunks.glsl.js';

/* ------------------------------------------------------------------ */
/* fireflies                                                          */
/* ------------------------------------------------------------------ */

const fireflyVertex = /* glsl */ `
uniform float uTime;
uniform float uProgress;
uniform float uPixelRatio;

attribute vec4 aSeed;

varying float vIntensity;
varying float vFogDepth;

${glslNoiseCommon}
${glslSnoise3}

void main() {
  vec3 pos = position;
  float t = uTime * 0.055;

  /* Slow 3D drift, straight from seed + time — the CPU never touches it. */
  vec3 np = position * 0.13;
  pos.x += snoise3(np + vec3(t, aSeed.x * 9.0, 0.0)) * 0.85;
  pos.y += snoise3(np + vec3(0.0, t * 0.8 + aSeed.y * 9.0, 3.7)) * 0.6;
  pos.z += snoise3(np + vec3(aSeed.z * 9.0, 0.0, t)) * 0.85;

  /* Hash-phased blink, 0.35 – 1.0 — every firefly on its own clock. */
  float blink = 0.35 + 0.65
    * (0.5 + 0.5 * sin(uTime * (0.55 + aSeed.w * 1.1) + aSeed.w * 6.2832));

  /* Thread proximity: within ~2.5 units of the LIT portion of the thread
     cylinder (radius THREAD_R), glow up to 1.6×. Cylinder distance is the
     cheap and honest approximation; the lit gate follows the progress
     front's group-local height, frontY = −uProgress · HELIX_H. */
  float dThread = abs(length(pos.xz) - THREAD_R);
  float frontY = -uProgress * HELIX_H;
  float litGate = smoothstep(frontY - 1.5, frontY + 0.75, pos.y);
  float prox = 1.0 - smoothstep(0.7, 2.5, dThread);
  float boost = 1.0 + 0.6 * prox * litGate;

  vIntensity = blink * boost;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  vFogDepth = -mvPosition.z;
  gl_PointSize = min(
    (4.0 + 5.0 * aSeed.x) * uPixelRatio * (24.0 / -mvPosition.z),
    40.0 * uPixelRatio);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const fireflyFragment = /* glsl */ `
uniform float fogNear;
uniform float fogFar;

varying float vIntensity;
varying float vFogDepth;

const vec3 AMBER = vec3(1.0, 0.4793, 0.1301);  // #FFB865
const vec3 SPARK = vec3(1.0, 0.8148, 0.6276);  // #FFE9C4

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  if (d2 > 1.0) discard;

  /* Soft gaussian core + faint warm halo, guaranteed zero at the rim. */
  float fall = exp(-d2 * 4.5) + 0.18 * exp(-d2 * 1.6);
  fall *= 1.0 - d2 * d2;

  vec3 col = mix(AMBER, SPARK, 0.78) * fall * vIntensity * 0.85;

  /* Additive fog: fade toward nothing with depth (see thread.js). */
  col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth) * 0.85;

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* starfield                                                          */
/* ------------------------------------------------------------------ */

const starVertex = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;

attribute float aSeed;

varying vec3 vColor;
varying float vTwinkle;

/* linear-sRGB */
const vec3 IVORY = vec3(0.9047, 0.8633, 0.7913);  // #F4EFE6
const vec3 GOLD  = vec3(1.0, 0.8148, 0.6276);     // #FFE9C4
const vec3 COOL  = vec3(0.5706, 0.6506, 0.8880);  // pale starlight blue

void main() {
  /* Cool → ivory → gold mix, seeded per star. */
  float m = fract(aSeed * 7.31);
  vColor = mix(mix(COOL, IVORY, clamp(m * 2.0, 0.0, 1.0)),
               GOLD, clamp(m * 2.0 - 1.0, 0.0, 1.0));

  /* Slow twinkle, hash-phased. */
  vTwinkle = 0.72 + 0.28
    * sin(uTime * (0.25 + fract(aSeed * 3.7) * 0.75) + aSeed * 41.0);

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (1.0 + 1.7 * fract(aSeed * 11.7)) * uPixelRatio;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const starFragment = /* glsl */ `
uniform float uOpacity;

varying vec3 vColor;
varying float vTwinkle;

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  if (d2 > 1.0) discard;
  float fall = 1.0 - d2;
  fall *= fall;

  gl_FragColor = vec4(vColor * fall * vTwinkle * uOpacity, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* nebulae                                                            */
/* ------------------------------------------------------------------ */

const nebulaVertex = /* glsl */ `
attribute vec3 aCenter;
attribute float aScale;
attribute float aSeed;

varying vec2 vUv;
varying float vSeed;

void main() {
  vUv = uv;
  vSeed = aSeed;

  /* Spherical billboard: place the sprite CENTER, then offset this corner
     in VIEW space — always camera-facing, all sprites in one draw call. */
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  mv.xy += position.xy * aScale;
  gl_Position = projectionMatrix * mv;
}
`;

const nebulaFragment = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform vec3 uEraTint;

varying vec2 vUv;
varying float vSeed;

${glslNoiseCommon}
${glslSnoise2}

/* linear-sRGB */
const vec3 DUSK  = vec3(0.0231, 0.0152, 0.0513);  // #2A2140 dusk violet
const vec3 AMBER = vec3(1.0, 0.4793, 0.1301);     // #FFB865

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  /* Soft disc envelope — zero at the quad edge, no billboard seams. */
  float env = 1.0 - smoothstep(0.2, 1.0, r2);

  /* 3-octave fbm, unrolled (no dynamic loops), drifting imperceptibly. */
  vec2 q = p * 1.7 + vSeed * 19.0;
  float dr = uTime * 0.008;
  float f = 0.5   * snoise2(q + vec2(dr, -dr * 0.7));
  f      += 0.25  * snoise2(q * 2.17 + vec2(-dr * 1.6, dr));
  f      += 0.125 * snoise2(q * 4.39 + vec2(dr * 0.9, dr * 1.4));
  f = clamp(f * 0.57 + 0.5, 0.0, 1.0);

  float cloud = f * f * env;

  /* Haze, not light: violet base with era-warmed amber pockets. Peak alpha
     = uOpacity by construction (cloud ≤ 1). */
  vec3 warm = mix(uEraTint, AMBER, 0.5);
  vec3 col = mix(DUSK, warm, min(cloud * 1.4, 1.0) * 0.55);

  gl_FragColor = vec4(col, cloud * uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* Authored placements: azimuth (rad, 0 = +Z toward the camera), radius,
   height, size, seed. Spread across the far and side hemispheres — nothing
   dead-ahead of the boot camera. */
const NEBULAE = [
  { az: 2.95, r: 62, y: -4, s: 66, seed: 0.13 },
  { az: -2.60, r: 54, y: 7, s: 50, seed: 0.47 },
  { az: -1.70, r: 48, y: -14, s: 44, seed: 0.71 },
  { az: 2.00, r: 52, y: 11, s: 48, seed: 0.29 },
  { az: 1.00, r: 70, y: -24, s: 70, seed: 0.88 },
];

/* ------------------------------------------------------------------ */
/* init                                                               */
/* ------------------------------------------------------------------ */

/* quality: { fireflies, stars } — counts come from the U7 tier object
   (js/quality.js); bare calls keep the shipped high-tier defaults.
   Returns { update(TIMELINE, dt), setEraTint(color), setDensity(f),
   count }. setDensity is the governor's draw-range hook: attributes are
   random-ordered, so drawing the first ⌊n·f⌋ points IS a uniform random
   subset — no rebuild, no allocation. */
export function initParticles(scene, spiralGroup, quality = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionScale = reduced ? 0 : 1;

  const nFireflies = Number.isFinite(quality.fireflies)
    ? Math.max(0, Math.floor(quality.fireflies)) : 220;
  const nStars = Number.isFinite(quality.stars)
    ? Math.max(0, Math.floor(quality.stars)) : 900;

  /* every Points geometry + its full count — setDensity walks this */
  const drawables = [];
  /* U10 outro: the star shells' own opacity uniforms + the authored value
     each one starts from, so setSkyBoost is a scale rather than a memory. */
  const starLayers = [];

  /* ---- shared uniforms: one object each, referenced by every material -- */
  const shared = {
    uTime: { value: 11.7 },   // non-zero: reduced-motion still gets variety
    uProgress: { value: 0 },
    uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) },
    uEraTint: { value: new THREE.Color('#F4EFE6') },
  };

  /* ---- fireflies: inside the helix volume, riding the world rig ------- */
  if (nFireflies > 0) {
    const pos = new Float32Array(nFireflies * 3);
    const seed = new Float32Array(nFireflies * 4);
    for (let i = 0; i < nFireflies; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      /* area-uniform annulus, 2 → RADIUS+1: brushes both thread and cards */
      const rad = 2 + (RADIUS - 1) * Math.sqrt(Math.random());
      pos[i * 3] = Math.sin(ang) * rad;
      pos[i * 3 + 1] = 2.5 - Math.random() * (HEIGHT + 5);
      pos[i * 3 + 2] = Math.cos(ang) * rad;
      seed[i * 4] = Math.random();
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));

    const material = new THREE.ShaderMaterial({
      vertexShader: fireflyVertex,
      fragmentShader: fireflyFragment,
      defines: {
        THREAD_R: THREAD_RADIUS.toFixed(4),
        HELIX_H: HEIGHT.toFixed(1),
      },
      uniforms: {
        uTime: shared.uTime,
        uProgress: shared.uProgress,
        uPixelRatio: shared.uPixelRatio,
        /* fogColor: dict-only, for the renderer's fog refresh (thread.js). */
        fogColor: { value: new THREE.Color('#2A2140') },
        fogNear: { value: 30 },
        fogFar: { value: 76 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });

    const fireflies = new THREE.Points(geo, material);
    fireflies.renderOrder = 2;      // after cards: depth-tested, adds in front
    fireflies.frustumCulled = false;
    spiralGroup.add(fireflies);
    drawables.push({ geo, n: nFireflies });
  }

  /* ---- starfield: two world-static shells beyond the fog -------------- */
  const starMat = (opacity) => new THREE.ShaderMaterial({
    vertexShader: starVertex,
    fragmentShader: starFragment,
    uniforms: {
      uTime: shared.uTime,
      uPixelRatio: shared.uPixelRatio,
      uOpacity: { value: opacity },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,                     // distant space: fog never dims them
  });

  const starShell = (count, radius, jitter, opacity) => {
    if (count <= 0) return;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const u = Math.random() * 2 - 1;               // uniform on the sphere
      const az = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = radius + (Math.random() * 2 - 1) * jitter;
      pos[i * 3] = s * Math.cos(az) * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = s * Math.sin(az) * r;
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const material = starMat(opacity);
    starLayers.push({ uniform: material.uniforms.uOpacity, base: opacity });
    const stars = new THREE.Points(geo, material);
    stars.renderOrder = -2;
    stars.frustumCulled = false;
    scene.add(stars);
    drawables.push({ geo, n: count });
  };

  const nInner = Math.round(nStars * 0.62);
  starShell(nInner, 60, 6, 0.35);
  starShell(nStars - nInner, 95, 8, 0.22);

  /* ---- nebulae: ONE merged geometry, one draw call -------------------- */
  {
    const n = NEBULAE.length;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const center = new Float32Array(n * 4 * 3);
    const scale = new Float32Array(n * 4);
    const seed = new Float32Array(n * 4);
    const index = new Uint16Array(n * 6);
    const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    const UVS = [[0, 0], [1, 0], [1, 1], [0, 1]];

    NEBULAE.forEach((neb, i) => {
      const cx = Math.sin(neb.az) * neb.r;
      const cz = Math.cos(neb.az) * neb.r;
      for (let j = 0; j < 4; j += 1) {
        const v = i * 4 + j;
        pos[v * 3] = CORNERS[j][0];
        pos[v * 3 + 1] = CORNERS[j][1];
        pos[v * 3 + 2] = 0;
        uv[v * 2] = UVS[j][0];
        uv[v * 2 + 1] = UVS[j][1];
        center[v * 3] = cx;
        center[v * 3 + 1] = neb.y;
        center[v * 3 + 2] = cz;
        scale[v] = neb.s;
        seed[v] = neb.seed;
      }
      index.set([0, 1, 2, 0, 2, 3].map((k) => i * 4 + k), i * 6);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aCenter', new THREE.BufferAttribute(center, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const material = new THREE.ShaderMaterial({
      vertexShader: nebulaVertex,
      fragmentShader: nebulaFragment,
      uniforms: {
        uTime: shared.uTime,
        uEraTint: shared.uEraTint,
        uOpacity: { value: 0.09 },
      },
      transparent: true,
      depthWrite: false,            // normal blending: haze, not light
      fog: false,
    });

    const nebulae = new THREE.Mesh(geo, material);
    nebulae.renderOrder = -3;       // the deepest layer, behind everything
    nebulae.frustumCulled = false;  // real placement happens in the shader
    scene.add(nebulae);
  }

  const api = {
    /* One uTime advance + one uProgress write per frame — that is ALL the
       CPU ever spends on 1100+ particles. */
    update(TIMELINE, dt) {
      shared.uTime.value += dt * motionScale;
      shared.uProgress.value = TIMELINE.smooth;
    },

    /* Ledger flow-through (app.js), same pattern as spiral.setEraTint. */
    setEraTint(color) {
      shared.uEraTint.value.copy(color);
    },

    /* U10 outro hook: past the last memory the fog pulls back and the
       starfield comes up with it — the void opening. `boost` is a fraction
       ADDED to the authored opacity (0 = the normal sky), recomputed from
       the base every call, so scrolling back up restores it exactly. */
    setSkyBoost(boost) {
      const b = Math.min(1.5, Math.max(0, boost || 0));
      for (let i = 0; i < starLayers.length; i += 1) {
        starLayers[i].uniform.value = starLayers[i].base * (1 + b);
      }
    },

    /* U7 governor hook: draw only the first ⌊n·f⌋ points of each layer —
       random-ordered buffers make that a uniform thinning, not a bald
       patch. Nebulae are 5 quads and stay untouched. */
    setDensity(fraction) {
      const f = Math.min(1, Math.max(0, fraction));
      let drawn = 0;
      for (let i = 0; i < drawables.length; i += 1) {
        const kept = Math.floor(drawables[i].n * f);
        drawables[i].geo.setDrawRange(0, kept);
        drawn += kept;
      }
      api.count = drawn;   // ?stats reads this — keep it truthful
    },

    count: nFireflies + nStars,
  };

  return api;
}
