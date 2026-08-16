/* boot.js — bootstrap: read flags, pick a path, retire the loader.

   U7 wires the real quality pipeline:
     ?grid=1            → js/fallback.js (the static grid, on request)
     no WebGL2 (floor)  → js/fallback.js (feature-detected, never UA-sniffed)
     otherwise          → detectTier() resolves a tier object from
                          js/quality.js (?tier= override always wins),
                          OMR_FLAGS.quality carries it into js/app.js.

   detectTier() is timeout-guarded inside quality.js — a dead CDN can slow
   boot by at most 2.5s, never hang it. */

import { detectTier } from './quality.js';

const params = new URLSearchParams(location.search);

window.OMR_FLAGS = {
  tier: params.get('tier'),   // raw override; resolved tier name lands below
  axes: params.has('axes'),
  shot: params.has('shot'),
  stats: params.has('stats'),
  post: params.get('post') !== '0',   // ?post=0 → pre-U6 direct render (A/B)
  grid: params.has('grid') && params.get('grid') !== '0',
  /* ?intro=1 replays the opening even when this session has seen it (the
     recording pass wants it every take); ?intro=0 suppresses it outright. */
  intro: params.has('intro') ? params.get('intro') !== '0' : null,
  /* ?cinema=1 auto-runs the U10 tour once the intro (if any) hands over —
     ?cinema=1&intro=1 is the full take, opening titles included. */
  cinema: params.has('cinema') && params.get('cinema') !== '0',
  /* ?mist=v2 swaps the GPGPU particle ink for the static photographic
     billboard field — an A/B the eye settles faster than an argument. */
  mist: params.get('mist') || 'v1',
  quality: null,              // the resolved tier object (render paths only)
};

const loader = document.getElementById('loader');

function retireLoader() {
  if (loader) loader.classList.add('done');
}

/* Both paths dispatch `omr:ready` (the app after its first rendered frame,
   the fallback once its grid is built); either signal retires the loader. */
addEventListener('omr:ready', retireLoader, { once: true });

async function boot() {
  if (window.OMR_FLAGS.grid) {
    const fallback = await import('./fallback.js');
    return fallback.start();
  }

  const tier = await detectTier(params.get('tier'));

  if (tier.name === 'floor') {
    const fallback = await import('./fallback.js');
    return fallback.start();
  }

  window.OMR_FLAGS.tier = tier.name;
  window.OMR_FLAGS.quality = tier;
  const app = await import('./app.js');
  return app.start();
}

boot()
  .then(retireLoader)
  .catch((err) => {
    console.error('[omr] boot failed:', err);
    if (loader) {
      loader.innerHTML =
        '<p class="boot-err">The scene did not start.<br>' +
        String((err && err.message) || err).slice(0, 300) +
        '</p>';
    }
  });
