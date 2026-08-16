/* eras.js — the ERA LEDGER: one cinematography + atmosphere row per era,
   sampled continuously along TIMELINE.smooth. Rows hold authored values;
   sample() eases INSIDE each segment (cubic smoothstep) so era boundaries
   land exactly on row values — the ledger is the single authority for
   camera radius, lens, fog and exposure from the first frame on.

   The color-temperature journey is authored by POSITION in the life, not
   by era id — initEras() maps whatever eras data/memories.json declares,
   in order, onto the arc below using each era's own tint. Nothing here
   hardcodes era ids. */

import * as THREE from 'three';

const BASE_BG = new THREE.Color('#101226');   // the void
const BASE_FOG = new THREE.Color('#2A2140');  // dusk violet
const FALLBACK_TINT = '#F4EFE6';              // album ivory

/* Authored journey, first row → last row:
   warmest dawn-gold birth → childhood amber → school rose → growing
   violet → searching cool dusk → NOW, the clearest ivory-warm row.

   FRAMING: the focused card (4.2 world-units tall) hangs at z = RADIUS = 14,
   so the true subject distance is d = camRadius − 14. Card height fraction
   of viewport = 4.2 / (2 · d · tan(fov/2)); these rows hold ~0.40–0.42:
     row0 d=11.4 fov 47.5 → 0.419      row4 d=13.0 fov 44.2 → 0.398

   DESCENT: the spiral runs downward, so every row lifts the eye a little
   (camHeightOffset > 0) and pitches it gently DOWN (tilt < 0, |tilt| ≤ 0.06
   rad) into the era rising from below; the deepest-searching row leans the
   furthest, the NOW row nearly levels out — arrival.

   lum    — bg luminance factor vs the void, held inside ±12%.
   bgMix  — how far the void leans toward the era tint before the
            luminance rescale (hue is felt, brightness is pinned).
   fogMix — how far dusk violet leans toward the tint (then partially
            desaturated, so the haze reads as temperature, not smoke). */
const JOURNEY = [
  { camRadius: 25.4, camHeightOffset: 0.25, fov: 47.5, tilt: -0.020, fogNear: 27, fogFar: 58, exposure: 1.10, lum: 1.10, bgMix: 0.13, fogMix: 0.32 },
  { camRadius: 25.8, camHeightOffset: 0.35, fov: 46.5, tilt: -0.030, fogNear: 28, fogFar: 60, exposure: 1.05, lum: 1.06, bgMix: 0.11, fogMix: 0.30 },
  { camRadius: 26.2, camHeightOffset: 0.45, fov: 45.5, tilt: -0.038, fogNear: 29, fogFar: 62, exposure: 1.00, lum: 1.00, bgMix: 0.10, fogMix: 0.28 },
  { camRadius: 26.6, camHeightOffset: 0.55, fov: 45.0, tilt: -0.046, fogNear: 29, fogFar: 60, exposure: 0.96, lum: 0.94, bgMix: 0.10, fogMix: 0.26 },
  { camRadius: 27.0, camHeightOffset: 0.65, fov: 44.2, tilt: -0.055, fogNear: 28, fogFar: 54, exposure: 0.92, lum: 0.89, bgMix: 0.09, fogMix: 0.24 },
  { camRadius: 25.6, camHeightOffset: 0.30, fov: 46.8, tilt: -0.012, fogNear: 31, fogFar: 72, exposure: 1.10, lum: 1.12, bgMix: 0.10, fogMix: 0.18 },
];

let rows = [];

/* The single frame object sample() writes into — zero allocation per call.
   Callers copy values out each frame; the reference is shared and mutates.
   Defaults mirror the U1 boot look so a pre-init sample is still sane. */
const frame = {
  camRadius: 26,
  camHeightOffset: 0,
  fov: 46,
  tilt: 0,
  world: {
    bg: BASE_BG.clone(),
    fog: BASE_FOG.clone(),
    fogNear: 30,
    fogFar: 76,
    eraTint: new THREE.Color(FALLBACK_TINT),
    exposure: 1,
    colorTemp: 0.6,
  },
};

function luminance(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/* Background: nudge the void toward the era tint for hue, then rescale so
   luminance lands exactly at baseLum · lumFactor — hue shifts are FELT,
   brightness stays inside the ±12% envelope by construction. */
function bgFor(tint, mix, lumFactor) {
  const c = BASE_BG.clone().lerp(tint, mix);
  const target = luminance(BASE_BG) * lumFactor;
  const l = Math.max(luminance(c), 1e-6);
  return c.multiplyScalar(target / l);
}

/* Fog: dusk violet pulled toward the era tint, then pulled 35% toward its
   own gray so the haze stays low-saturation. */
function fogFor(tint, mix) {
  const c = BASE_FOG.clone().lerp(tint, mix);
  const g = luminance(c);
  return c.lerp(new THREE.Color(g, g, g), 0.35);
}

/* Cubic smoothstep INSIDE a segment: exactly 0 and 1 at the segment ends,
   so sample(i / (rows − 1)) returns row i exactly. */
function smoothstep(u) {
  return u * u * (3 - 2 * u);
}

/* Build the ledger from data/memories.json ({ eras: [{ id, tint, … }] }).
   Era ids and order come from the data; an era count other than 6 simply
   stretches the authored journey across however many rows exist.
   Returns the rows (also kept module-side for sample()). */
export function initEras(data) {
  const eras = (data && data.eras) || [];
  const n = eras.length;
  rows = eras.map((era, i) => {
    const jIndex = n > 1 ? Math.round((i * (JOURNEY.length - 1)) / (n - 1)) : 0;
    const j = JOURNEY[jIndex];
    const tint = new THREE.Color(era.tint || FALLBACK_TINT);
    return {
      id: era.id,
      camRadius: j.camRadius,
      camHeightOffset: j.camHeightOffset,
      fov: j.fov,
      tilt: j.tilt,
      world: {
        bg: bgFor(tint, j.bgMix, j.lum),
        fog: fogFor(tint, j.fogMix),
        fogNear: j.fogNear,
        fogFar: j.fogFar,
        eraTint: tint,
        exposure: j.exposure,
        /* colorTemp (0..1, warm→1) rides in from the era data untouched —
           U6's FilmGrade white-balance reads the interpolated value. */
        colorTemp: typeof era.colorTemp === 'number' ? era.colorTemp : 0.6,
      },
    };
  });
  return rows;
}

/* Copy one row into the shared frame verbatim — used at segment ends so
   boundaries are EXACT row values, immune to a+(b−a)·1 float drift. */
function copyRow(row) {
  frame.camRadius = row.camRadius;
  frame.camHeightOffset = row.camHeightOffset;
  frame.fov = row.fov;
  frame.tilt = row.tilt;
  frame.world.bg.copy(row.world.bg);
  frame.world.fog.copy(row.world.fog);
  frame.world.fogNear = row.world.fogNear;
  frame.world.fogFar = row.world.fogFar;
  frame.world.eraTint.copy(row.world.eraTint);
  frame.world.exposure = row.world.exposure;
  frame.world.colorTemp = row.world.colorTemp;
}

/* smooth → interpolated frame state between the two adjacent rows.
   Input is clamped to [0,1]; NaN and out-of-range values are safe and
   land on the nearest end row. Returns the shared frame object. */
export function sample(smooth) {
  if (!rows.length) return frame;

  /* NaN → 0; ±Infinity and out-of-range clamp to the end rows. */
  const s = Math.min(1, Math.max(0, Number.isNaN(smooth) ? 0 : smooth));
  const last = rows.length - 1;

  let a = rows[0];
  let b = rows[0];
  let e = 0;
  if (last > 0) {
    const scaled = s * last;
    const i = Math.min(last - 1, Math.floor(scaled));
    a = rows[i];
    b = rows[i + 1];
    e = smoothstep(Math.min(1, Math.max(0, scaled - i)));
  }

  if (e <= 0) {
    copyRow(a);
    return frame;
  }
  if (e >= 1) {
    copyRow(b);
    return frame;
  }

  frame.camRadius = a.camRadius + (b.camRadius - a.camRadius) * e;
  frame.camHeightOffset =
    a.camHeightOffset + (b.camHeightOffset - a.camHeightOffset) * e;
  frame.fov = a.fov + (b.fov - a.fov) * e;
  frame.tilt = a.tilt + (b.tilt - a.tilt) * e;

  frame.world.bg.copy(a.world.bg).lerp(b.world.bg, e);
  frame.world.fog.copy(a.world.fog).lerp(b.world.fog, e);
  frame.world.fogNear = a.world.fogNear + (b.world.fogNear - a.world.fogNear) * e;
  frame.world.fogFar = a.world.fogFar + (b.world.fogFar - a.world.fogFar) * e;
  frame.world.eraTint.copy(a.world.eraTint).lerp(b.world.eraTint, e);
  frame.world.exposure = a.world.exposure + (b.world.exposure - a.world.exposure) * e;
  frame.world.colorTemp =
    a.world.colorTemp + (b.world.colorTemp - a.world.colorTemp) * e;

  return frame;
}
