/* hud.js — the instrument cluster: era-index rail, rolling year odometer,
   decoding era label, and coordinate set-dressing. DOM only — each rAF it
   reads TIMELINE + the ledger frame and writes text/transforms, never the
   scene. Every write is change-gated so a settled frame costs nothing.
   All CSS lives in index.html's <style>. */

import { gsap } from 'gsap';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·—';
const SEP = '∕'; // division slash — the archive's fraction mark (MEM 07∕14)
const SCRAMBLE_SECONDS = 0.7;

/* ---------------- pure helpers (exported for tests) -------------------- */

/* Year shown for a given smooth ∈ [0,1]: piecewise-linear interpolation
   across the memories' own years (ascending in the manifest), floored to
   the year actually reached — strictly non-decreasing as smooth grows. */
export function yearAt(smooth, years) {
  const count = years.length;
  if (!count) return 0;
  const s = Math.min(1, Math.max(0, Number.isNaN(smooth) ? 0 : smooth));
  if (count === 1) return years[0];
  const scaled = s * (count - 1);
  const i = Math.min(count - 2, Math.floor(scaled));
  return Math.floor(years[i] + (years[i + 1] - years[i]) * (scaled - i));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ---------------- module state ---------------- */

let built = false;
let eras = [];
let years = [];
let memoryCount = 0;
let digitCount = 4;

let entries = [];
let strips = [];
let currentDigits = [];
let microEl = null;
let labelTitle = null;
let labelSub = null;
let liveEl = null;

let lastYear = null;
let lastMicro = '';
let lastEraIdx = -1;
let lastLive = '';

function div(className, parent) {
  const node = document.createElement('div');
  if (className) node.className = className;
  parent.appendChild(node);
  return node;
}

/* Decode-into-place: every unsettled character cycles the archive glyphs
   while a left-to-right sweep locks them in over ~0.7s. Hand-rolled on the
   gsap core ticker — no ScrambleText plugin assumed. Exported: the U8
   focus readout decodes its year through the SAME aesthetic. */
const activeScrambles = new Map();
export function scrambleTo(node, text) {
  const prev = activeScrambles.get(node);
  if (prev) prev.kill();
  const n = text.length;
  const state = { p: 0 };
  const tween = gsap.to(state, {
    p: 1,
    duration: SCRAMBLE_SECONDS,
    ease: 'none',
    onUpdate() {
      let out = '';
      for (let i = 0; i < n; i += 1) {
        const ch = text[i];
        if (ch === ' ') {
          out += ' ';
        } else if (state.p * n >= i + 1) {
          out += ch; // settled, left to right
        } else {
          out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
      }
      node.textContent = out;
    },
    onComplete() {
      node.textContent = text;
      activeScrambles.delete(node);
    },
  });
  activeScrambles.set(node, tween);
}

/* ---------------- construction ---------------- */

/* initHud(data, { onEraClick }) — data is { eras, memories } straight from
   data/memories.json; onEraClick(index) is the wire back to the scroll
   conductor. Builds into the U1 skeleton divs, creates #era-label and
   #micro-readouts. */
export function initHud(data, { onEraClick } = {}) {
  eras = (data && data.eras) || [];
  const memories = (data && data.memories) || [];
  years = memories.map((m) => m.year);
  memoryCount = memories.length;
  digitCount = years.length ? String(Math.max(...years)).length : 4;

  /* ---- era index: right-edge vertical rail, one entry per era ---- */
  const indexEl = document.getElementById('era-index');
  indexEl.textContent = '';
  entries = eras.map((era, i) => {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'ei-entry';
    const label = document.createElement('span');
    label.className = 'ei-label';
    /* The rail is a year scale, not a list of names. */
    const yr = era.yearRange || [];
    label.textContent = yr[0] != null ? String(yr[0]) : String(i + 1);
    const tick = document.createElement('span');
    tick.className = 'ei-tick';
    entry.append(label, tick);
    /* Names survive for assistive tech only — never on screen. */
    entry.setAttribute('aria-label',
      (era.label || era.id || '') + ' ' + (yr[0] || '') + '–' + (yr[1] || ''));
    entry.addEventListener('click', () => {
      if (onEraClick) onEraClick(i);
    });
    indexEl.appendChild(entry);
    return entry;
  });

  /* ---- year odometer: bottom-left, rolling digit strips ---- */
  const yearEl = document.getElementById('year-hud');
  yearEl.textContent = '';
  div('odo-rule', yearEl);
  const odo = div('odo', yearEl);
  odo.setAttribute('aria-hidden', 'true');
  strips = [];
  currentDigits = [];
  for (let c = 0; c < digitCount; c += 1) {
    const col = document.createElement('span');
    col.className = 'odo-col';
    const strip = document.createElement('span');
    strip.className = 'odo-strip';
    for (let d = 0; d <= 9; d += 1) {
      const cell = document.createElement('span');
      cell.className = 'odo-digit';
      cell.textContent = String(d);
      strip.appendChild(cell);
    }
    col.appendChild(strip);
    odo.appendChild(col);
    strips.push(strip);
    currentDigits.push(-1);
  }
  microEl = div('odo-micro', yearEl);

  /* ---- era label: center-left, the ONLY non-mono instrument ---- */
  let labelEl = document.getElementById('era-label');
  if (!labelEl) {
    labelEl = document.createElement('div');
    labelEl.id = 'era-label';
    document.body.appendChild(labelEl);
  }
  labelEl.textContent = '';
  labelTitle = div('el-title', labelEl);
  labelSub = div('el-sub', labelEl);

  /* ---- micro readouts: top-right set-dressing ---- */
  let microHud = document.getElementById('micro-readouts');
  if (!microHud) {
    microHud = document.createElement('div');
    microHud.id = 'micro-readouts';
    document.body.appendChild(microHud);
  }
  microHud.textContent = '';
  div('', microHud).textContent = 'LAT 30.0444 N · LNG 31.2357 E';
  div('', microHud).textContent = 'ARCHIVE ' + SEP + ' LIFE.01';
  liveEl = div('', microHud);

  lastYear = null;
  lastMicro = '';
  lastEraIdx = -1;
  lastLive = '';
  built = true;
}

/* Mechanical-counter roll: each changed column tweens its stacked strip;
   yPercent is −10 per digit because the strip is 10 cells tall. */
function setYear(year, instant) {
  const text = String(year).padStart(digitCount, '0');
  for (let c = 0; c < digitCount; c += 1) {
    const d = text.charCodeAt(c) - 48;
    if (d === currentDigits[c]) continue;
    currentDigits[c] = d;
    if (instant) {
      gsap.set(strips[c], { yPercent: -d * 10 });
    } else {
      gsap.to(strips[c], {
        yPercent: -d * 10,
        duration: 0.55,
        ease: 'power3.out',
        overwrite: 'auto',
      });
    }
  }
}

function setEra(index) {
  for (let i = 0; i < entries.length; i += 1) {
    entries[i].classList.toggle('current', i === index);
  }
  const era = eras[index];
  if (!era) return;
  /* Eras are named by their years, never by words — the photographs say
     "childhood" better than the label did. The big element decodes the
     span itself; the mono subtitle is retired. */
  const range = era.yearRange || [];
  scrambleTo(labelTitle,
    (range[0] != null ? range[0] : '····') +
    ' — ' + (range[1] != null ? range[1] : '····'));
  labelSub.textContent = '';
}

/* ---------------- per-frame ---------------- */

export function update(TIMELINE, frame) {
  if (!built) return;
  const s = Math.min(
    1,
    Math.max(0, Number.isNaN(TIMELINE.smooth) ? 0 : TIMELINE.smooth)
  );

  /* Rolling year — never a plain text swap. */
  const year = yearAt(s, years);
  if (year !== lastYear) {
    setYear(year, lastYear === null);
    lastYear = year;
  }

  /* MEM 07∕14 · 23% — nearest memory, manifest total, progress. */
  if (memoryCount) {
    const mem = memoryCount > 1 ? Math.round(s * (memoryCount - 1)) + 1 : 1;
    const text =
      'MEM ' + pad2(mem) + SEP + pad2(memoryCount) +
      ' · ' + Math.round(s * 100) + '%';
    if (text !== lastMicro) {
      microEl.textContent = text;
      lastMicro = text;
    }
  }

  /* Current era: the conductor's chapter when available (exact-scroll
     truth), else the nearest ledger row. */
  let eraIdx = TIMELINE.active;
  if (!Number.isInteger(eraIdx) || eraIdx < 0 || eraIdx >= eras.length) {
    eraIdx = eras.length > 1 ? Math.round(s * (eras.length - 1)) : 0;
  }
  if (eraIdx !== lastEraIdx) {
    lastEraIdx = eraIdx;
    setEra(eraIdx);
  }

  /* Live lens line — the cluster provably reads the scene, not a script. */
  const live =
    'FOV ' + frame.fov.toFixed(1) + ' · EXP ' + frame.world.exposure.toFixed(2);
  if (live !== lastLive) {
    liveEl.textContent = live;
    lastLive = live;
  }
}
