/* quality.js — U7: the tier table, boot-time detection, and the demote-only
   runtime governor.

   TIERS holds every knob the rest of the app reads (js/app.js fans the
   object out to renderer / spiral / particles / post / textures); `floor`
   is NOT a render tier — it means "no WebGL2", and boot.js routes it to
   the static grid in js/fallback.js instead of importing the app at all.

   detectTier() is FAIL-SAFE by construction: detect-gpu arrives from a CDN
   and is raced against a hard timeout, so a dead CDN or a slow network can
   never hang the boot — the heuristic path answers instead. The ?tier
   override always wins (both namings: base|mid|high and legacy 1|2|3).

   createGovernor() is a pure state machine over caller-supplied timestamps
   (exported for unit tracing): a rolling fps window sampled in the rAF;
   a sustained average below MIN_FPS demotes ONE ladder step, with a
   cooldown between demotions. It NEVER promotes — a step down is for the
   session. Nothing here persists anything. */

/* ------------------------------------------------------------------ */
/* tier table                                                          */
/* ------------------------------------------------------------------ */

export const TIERS = {
  base: {
    name: 'base',
    dpr: 1.25,
    fireflies: 90,
    stars: 400,
    bloom: false,
    cardSubdiv: [12, 16],
    /* Mobile still evicts — VRAM is the constraint there. Desktop tiers keep
       every card resident (see mid/high): re-entering a card's window used to
       reload it and replay the blur-up, which read as a blur "arriving" with
       the photo. 14 photos ≈ 3 MB, so residency is free above mobile. */
    texWindow: 3,
  },
  mid: {
    name: 'mid',
    dpr: 1.5,
    fireflies: 160,
    stars: 650,
    bloom: true,
    cardSubdiv: [24, 32],
    texWindow: 99,   // all resident: no eviction, no re-blur on approach
  },
  high: {
    name: 'high',
    dpr: 2,
    fireflies: 220,
    stars: 900,
    bloom: true,
    cardSubdiv: [24, 32],
    texWindow: 99,   // all resident: no eviction, no re-blur on approach
  },
};

/* Not a render tier: no WebGL2 → boot.js imports js/fallback.js. */
export const FLOOR = { name: 'floor' };

/* ?tier= accepts both namings; the legacy digits map onto the ladder. */
const OVERRIDES = {
  base: 'base', mid: 'mid', high: 'high',
  1: 'base', 2: 'mid', 3: 'high',
};

/* ------------------------------------------------------------------ */
/* boot-time detection                                                 */
/* ------------------------------------------------------------------ */

const DETECT_TIMEOUT_MS = 2500;

/* Feature-detect, never UA-sniff: three r170 requires WebGL2. */
export function webgl2Available() {
  try {
    if (typeof WebGL2RenderingContext === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch (err) {
    return false;
  }
}

/* detect-gpu result → tier key. Spec mapping: tier 0/1 → base, tier 2 →
   mid, tier 3 → high on desktop (a tier-3 PHONE still lands on mid — its
   thermal budget is not a desktop's). */
export function mapGpuTier(gpu) {
  if (gpu.tier <= 1) return 'base';
  if (gpu.tier === 2) return 'mid';
  return gpu.isMobile ? 'mid' : 'high';
}

/* Heuristic fallback for when detect-gpu is unreachable or slow. Mobile is
   pointer/touch capability, not UA. Desktop defaults HIGH (the shipped
   default — the governor catches over-optimism); small or ultra-dense
   mobile screens read low-power → base, larger touch devices → mid.
   All inputs injectable for unit tracing. */
export function heuristicTier({ isMobile, dpr, shortSide } = {}) {
  const mobile = isMobile !== undefined
    ? isMobile
    : (matchMedia('(pointer: coarse)').matches
       && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window));
  if (!mobile) return 'high';
  const ratio = dpr !== undefined ? dpr : (devicePixelRatio || 1);
  const side = shortSide !== undefined
    ? shortSide
    : Math.min(screen.width || 1024, screen.height || 768);
  return (side < 768 || ratio >= 3) ? 'base' : 'mid';
}

/* Hard timeout guard: settles with the promise OR rejects at ms — and the
   handlers are attached immediately, so a late CDN rejection lands on an
   already-settled Promise (a no-op), never an unhandled rejection. */
function raceTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('detect-gpu timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/* detectTier(override, opts) → one of TIERS.* or FLOOR.
     1. no WebGL2 → FLOOR (even an explicit ?tier cannot render without it)
     2. ?tier override → that tier, no detection at all
     3. detect-gpu (CDN, ≤ 2.5s) → mapGpuTier
     4. timeout / error → heuristicTier
   opts { hasWebGL2, gpuProbe, timeoutMs, heuristic } exist for unit
   tracing only; the browser path passes nothing. */
export async function detectTier(override, opts = {}) {
  const hasWebGL2 = 'hasWebGL2' in opts ? opts.hasWebGL2 : webgl2Available();
  if (!hasWebGL2) return FLOOR;

  const key = override != null ? OVERRIDES[String(override).toLowerCase()] : undefined;
  if (key) return TIERS[key];

  try {
    const gpu = await raceTimeout(
      opts.gpuProbe
        ? opts.gpuProbe()
        : import('detect-gpu').then((mod) => mod.getGPUTier()),
      opts.timeoutMs || DETECT_TIMEOUT_MS,
    );
    if (gpu && typeof gpu.tier === 'number') return TIERS[mapGpuTier(gpu)];
  } catch (err) {
    /* CDN down, blocked, or slow — the site must never hang on it. */
  }
  return TIERS[heuristicTier(opts.heuristic)];
}

/* ------------------------------------------------------------------ */
/* runtime governor — demote-only                                      */
/* ------------------------------------------------------------------ */

const WINDOW_MS = 2500;   // rolling fps window
/* Demote below this average. Deliberately well under 60: a scene running
   at 52 is smooth, and the bloom/grade chain IS the look — spending it to
   claw back eight frames is a bad trade. This threshold is for rescuing a
   genuinely struggling machine, not for policing the fifties. */
const MIN_FPS = 38;
const COOLDOWN_MS = 8000; // between demotions — let the last one land
const GRACE_MS = 3000;    // ignore boot jank (shader compiles, first loads)
const STALL_MS = 500;     // rAF gap → tab was hidden; the window is a lie

/* The ladder DOWN from a given tier, in order — each entry is one demotion
   step app.js knows how to apply:
     'dpr'     → pixel ratio down to 1.5      (only if the tier sits above)
     'bloom'   → bloom pass off               (only if the tier has it)
     'density' → halve fireflies + stars via drawRange (always last resort)
   high → [dpr, bloom, density] ends base-equivalent; mid → [bloom,
   density]; base → [density] — the one knob a struggling floor-adjacent
   device has left. */
export function buildLadder(quality) {
  const steps = [];
  if (quality.dpr > 1.5) steps.push('dpr');
  if (quality.bloom) steps.push('bloom');
  steps.push('density');
  return steps;
}

/* createGovernor({ ladder, onDemote, … }) → { sample(now), state() }.
   sample(now) is called once per rAF with the frame timestamp (ms) and is
   PURE over those timestamps — no Date.now, no globals — so the ladder
   order and cooldown are unit-traceable with synthetic clocks.
   Returns the step name when a demotion fires, else null. */
export function createGovernor({
  ladder = [],
  onDemote = () => {},
  windowMs = WINDOW_MS,
  minFps = MIN_FPS,
  cooldownMs = COOLDOWN_MS,
  graceMs = GRACE_MS,
  stallMs = STALL_MS,
} = {}) {
  const pending = ladder.slice();
  const applied = [];
  let firstSample = -1;
  let windowStart = -1;
  let suspended = false;
  let lastSample = -1;
  let frames = 0;
  let avgFps = 0;
  let lastDemote = -Infinity;

  function resetWindow(now) {
    windowStart = now;
    frames = 0;
  }

  function sample(now) {
    if (firstSample < 0) firstSample = now;
    if (windowStart < 0) { resetWindow(now); lastSample = now; return null; }

    /* A transient set piece is not the steady state. The intro runs a
       second GPGPU system on top of the whole world for a few seconds;
       judging that window would spend the session's quality on four
       seconds of spectacle and leave the actual experience — the part
       the visitor spends minutes in — permanently stripped. */
    if (suspended) {
      resetWindow(now);
      lastSample = now;
      return null;
    }

    /* A long rAF gap means a hidden tab or a system stall, not a slow
       renderer — judging that window would demote an innocent frame rate. */
    if (now - lastSample > stallMs) {
      resetWindow(now);
      lastSample = now;
      return null;
    }
    lastSample = now;

    frames += 1;
    const elapsed = now - windowStart;
    if (elapsed < windowMs) return null;

    avgFps = (frames * 1000) / elapsed;
    resetWindow(now);

    if (now - firstSample < graceMs) return null;   // boot jank amnesty
    if (avgFps >= minFps) return null;
    if (!pending.length) return null;               // ladder exhausted
    if (now - lastDemote < cooldownMs) return null; // let the last step land

    lastDemote = now;
    const step = pending.shift();
    applied.push(step);
    onDemote(step);
    return step;
  }

  /* Suspend judgement across a set piece (the intro, a cinema take), then
     resume with a fresh window and a fresh grace period — the first frames
     back still carry the piece's shader compiles and texture uploads. */
  function setSuspended(v, now) {
    const next = !!v;
    if (next === suspended) return;
    suspended = next;
    if (!suspended && Number.isFinite(now)) {
      resetWindow(now);
      lastSample = now;
      firstSample = now;   // re-arm the grace amnesty
    }
  }

  /* For ?stats — cheap, allocation-light, never promoted. */
  function state() {
    return {
      avgFps,
      demotions: applied.length,
      applied: applied.join('+') || 'none',
      pending: pending.length,
    };
  }

  return { sample, state, setSuspended };
}
