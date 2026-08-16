/* textures.js — the texture window + placeholder factory.

   Every card gets a live "record" of uniform slots (uMap / uDepth /
   uHasDepth / uReveal — objects with a .value, handed straight into that
   card's ShaderMaterial). The window manager mutates .value as assets
   arrive or leave; the materials see it instantly, no rebinding.

   404 is the NORMAL path today (no photos shipped yet by design): each
   asset gets exactly ONE HEAD pre-check per session — miss → the card
   keeps its premium placeholder, silently. TextureLoader only ever runs
   against assets the probe confirmed, so three.js never error-logs. */

import * as THREE from 'three';
import { gsap } from 'gsap';

/* Placeholder canvas size — matches the card aspect (3.2 / 4.2 ≈ 0.762). */
const PW = 512;
const PH = 672;

const VOID = [16, 18, 38];     // #101226
const IVORY = [244, 239, 230]; // #F4EFE6

/* ---- tiny sRGB-space color helpers (canvas paints in sRGB) ------------ */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function grayOf(c) {
  const g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [g, g, g];
}
function css(c, a) {
  return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')';
}

/* createPlaceholder(memory, era) → CanvasTexture: a premium "empty archive
   slide" — era-derived warm gradient sinking into the void, film-frame
   border, faint grain, the year etched large at 8% opacity, the title in
   small caps at 20%, registration crosses in the corners. Intentional in
   a reel even before a single photo exists. */
export function createPlaceholder(memory, era) {
  const canvas = document.createElement('canvas');
  canvas.width = PW;
  canvas.height = PH;
  const ctx = canvas.getContext('2d');

  /* vertical warm gradient: era tint desaturated and darkened toward the
     void at the top, nearly-void at the bottom — dark, never flat. */
  const tint = hexToRgb((era && era.tint) || '#F4EFE6');
  const top = mixRgb(mixRgb(tint, grayOf(tint), 0.45), VOID, 0.55);
  const bottom = mixRgb(tint, VOID, 0.9);
  const grad = ctx.createLinearGradient(0, 0, 0, PH);
  grad.addColorStop(0, css(top, 1));
  grad.addColorStop(1, css(bottom, 1));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PW, PH);

  /* faint film grain */
  for (let i = 0; i < 1700; i += 1) {
    const v = (200 + Math.random() * 55) | 0;
    ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.03)';
    ctx.fillRect(Math.random() * PW, Math.random() * PH, 1, 1);
  }

  /* fine film-frame border: outer stroke + inner hairline */
  ctx.strokeStyle = css(IVORY, 0.16);
  ctx.lineWidth = 2;
  ctx.strokeRect(10.5, 10.5, PW - 21, PH - 21);
  ctx.strokeStyle = css(IVORY, 0.07);
  ctx.lineWidth = 1;
  ctx.strokeRect(17.5, 17.5, PW - 35, PH - 35);

  /* corner registration marks */
  ctx.strokeStyle = css(IVORY, 0.18);
  ctx.lineWidth = 1;
  const m = 30;
  const arm = 7;
  [[m, m], [PW - m, m], [m, PH - m], [PW - m, PH - m]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
  });

  /* the year, etched large */
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = css(IVORY, 0.08);
  ctx.font = '500 190px "Spline Sans Mono", ui-monospace, monospace';
  ctx.fillText(String(memory.year || '····'), PW / 2, PH * 0.46);

  /* the title, small caps */
  ctx.fillStyle = css(IVORY, 0.2);
  ctx.font = '400 21px "Spline Sans Mono", ui-monospace, monospace';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '5px';
  ctx.fillText((memory.title || '').toUpperCase(), PW / 2, PH * 0.6);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* createPlaceholderDepth() → soft radial gradient CanvasTexture (bright
   center = near). One shared instance keeps every uDepth sampler valid;
   the shader's uHasDepth=0 path uses its own procedural radial anyway. */
export function createPlaceholderDepth() {
  const S = 128;
  const H = 168;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, H / 2, 8, S / 2, H / 2, H * 0.62);
  g.addColorStop(0, 'rgb(205,205,205)');
  g.addColorStop(1, 'rgb(58,58,58)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, H);
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture; // colorSpace stays NoColorSpace: depth is data, not color
}

/* initTextures(memories, { window, renderer, eras })
   → { acquire(memoryIndex), update(smooth), dispose(), stats() }

   Resident window: indices within ±window of the current memory — the
   quality tier's texWindow (U7): ±2 on base, ±4 on mid/high. All 14 would
   fit on desktop; the window is still enforced for tier discipline.
   Textures leaving the window are disposed — placeholders never are
   (shared/cheap, they live for the session). */
export function initTextures(memories, { window: windowSize = 4, renderer = null, eras = [] } = {}) {
  const win = Number.isFinite(windowSize) ? Math.max(0, Math.floor(windowSize)) : 4;
  const maxAniso = Math.min(
    8,
    renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 8
  );
  const loader = new THREE.TextureLoader();
  const eraById = new Map(eras.map((e) => [e.id, e]));
  const depthPlaceholder = createPlaceholderDepth();

  const records = memories.map((memory) => {
    const placeholder = createPlaceholder(memory, eraById.get(memory.era));
    placeholder.anisotropy = maxAniso;
    return {
      memory,
      placeholder,
      /* live uniform slots — spiral.js wires these into the material */
      uMap: { value: placeholder },
      uDepth: { value: depthPlaceholder },
      uHasDepth: { value: 0 },
      uReveal: { value: 1 }, // placeholders show sharp; photos blur-up on arrival
      state: 'idle', // idle | loading | resident | missing
      wanted: false,
      probed: null, // null = never probed; true/false is sticky for the session
      probedDepth: null,
      texture: null,
      depthTexture: null,
    };
  });

  /* One silent HEAD per asset per session — 404 is normal, not an error. */
  async function probe(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  async function loadDepth(rec) {
    if (!rec.memory.depth) return;
    if (rec.probedDepth === null) rec.probedDepth = await probe(rec.memory.depth);
    if (!rec.probedDepth || !rec.wanted) return;
    loader.load(
      rec.memory.depth,
      (tex) => {
        if (!rec.wanted) { tex.dispose(); return; }
        tex.colorSpace = THREE.LinearSRGBColorSpace; // data, not color
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        rec.depthTexture = tex;
        rec.uDepth.value = tex;
        rec.uHasDepth.value = 1;
      },
      undefined,
      () => {} // probe said yes but load failed — stay on pseudo-depth, silently
    );
  }

  async function load(rec) {
    if (!rec.memory.src) { rec.state = 'missing'; return; }  // manifest mid-rewrite
    rec.state = 'loading';
    if (rec.probed === null) rec.probed = await probe(rec.memory.src);
    if (!rec.probed) { rec.state = 'missing'; return; }
    if (!rec.wanted) { rec.state = 'idle'; return; }
    loader.load(
      rec.memory.src,
      (tex) => {
        if (!rec.wanted) { tex.dispose(); rec.state = 'idle'; return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = maxAniso; // mipmaps stay on (TextureLoader default)
        rec.texture = tex;
        rec.uMap.value = tex;
        rec.uReveal.value = 0; // blur-up: 9-tap soft → sharp over 0.9s
        gsap.to(rec.uReveal, { value: 1, duration: 0.9, ease: 'power2.out', overwrite: true });
        rec.state = 'resident';
        loadDepth(rec);
      },
      undefined,
      () => { rec.state = 'missing'; }
    );
  }

  function evict(rec) {
    rec.wanted = false;
    gsap.killTweensOf(rec.uReveal);
    if (rec.texture) { rec.texture.dispose(); rec.texture = null; }
    if (rec.depthTexture) { rec.depthTexture.dispose(); rec.depthTexture = null; }
    rec.uMap.value = rec.placeholder;
    rec.uDepth.value = depthPlaceholder;
    rec.uHasDepth.value = 0;
    rec.uReveal.value = 1;
    if (rec.state === 'resident') rec.state = 'idle';
    /* 'loading' unwinds itself via the wanted flag; 'missing' stays missing. */
  }

  let lastIndex = -1;
  const statsObj = { resident: 0, loading: 0, missing: 0 };

  return {
    /* the card's live uniform-slot record — see the file header */
    acquire(memoryIndex) {
      return records[memoryIndex];
    },

    /* Per-frame from spiral.update — early-outs unless the nearest memory
       index changed, so the steady state costs one compare. */
    update(smooth) {
      const s = Math.min(1, Math.max(0, Number.isNaN(smooth) ? 0 : smooth));
      const idx = memories.length > 1 ? Math.round(s * (memories.length - 1)) : 0;
      if (idx === lastIndex) return;
      lastIndex = idx;
      for (let i = 0; i < records.length; i += 1) {
        const rec = records[i];
        if (Math.abs(i - idx) <= win) {
          rec.wanted = true;
          if (rec.state === 'idle') load(rec);
        } else if (rec.wanted) {
          evict(rec);
        }
      }
    },

    /* for the ?stats overlay — reuses one object, zero per-call garbage */
    stats() {
      let resident = 0;
      let loading = 0;
      let missing = 0;
      for (let i = 0; i < records.length; i += 1) {
        const st = records[i].state;
        if (st === 'resident') resident += 1;
        else if (st === 'loading') loading += 1;
        else if (st === 'missing') missing += 1;
      }
      statsObj.resident = resident;
      statsObj.loading = loading;
      statsObj.missing = missing;
      return statsObj;
    },

    /* full teardown — the only path that disposes placeholders */
    dispose() {
      for (let i = 0; i < records.length; i += 1) {
        evict(records[i]);
        records[i].placeholder.dispose();
      }
      depthPlaceholder.dispose();
    },
  };
}
