/* scroll.js — every way time moves: native scroll (via the vendored
   conductor), drag-to-spin with momentum, and idle auto-spin.
   All decay in this file uses the dt-correct form 1 - Math.exp(-lambda*dt);
   per-frame `*= k` multipliers are frame-rate dependent and banned. */

/* UMD vendor file: importing it for side effect installs
   window.createScrollConductor (see vendor/scroll-conductor.LICENSE). */
import './vendor/scroll-conductor.js';

const SECTION_SELECTOR = '.era-track';
/* U10: app.js appends ONE extra track past the last memory, marked
   data-outro. It is NOT part of the era span — scrolling through it carries
   TIMELINE.smooth from 1 to 1 + OUTRO_REACH, which is the whole zone
   js/outro.js listens on. Without that section everything below collapses
   back to the plain progress/span mapping. */
const OUTRO_ATTR = 'outro';
const OUTRO_REACH = 0.12;

const VELOCITY_LAMBDA = 4;     // smoothing on d(smooth)/dt
const MOMENTUM_LAMBDA = 2.5;   // post-release spin decay
const DRAG_SMOOTH_LAMBDA = 12; // smoothing on instantaneous drag velocity
const DRAG_SWEEP = Math.PI;    // a full-viewport drag = half a turn
const IDLE_DELAY = 4;          // seconds of stillness before auto-spin
const AUTO_RATE = 0.02;        // rad/s, barely-noticeable drift

export function initScroll(TIMELINE, canvas) {
  /* U8 focus suspension: while a memory is staged (TIMELINE.source ===
     'focus'), focus.js freezes the document scroll itself and raises this
     flag to stop the OTHER time movers — drag-to-spin, its momentum tail,
     and the idle auto-spin. */
  let suspended = false;
  /* U10 cinema: while the tour owns TIMELINE, the conductor keeps reading
     the (frozen) document but stops writing — one source at a time. */
  let external = false;

  const sections = document.querySelectorAll(SECTION_SELECTOR);
  /* The conductor reports progress in section-index units [0 .. N-1];
     TIMELINE speaks normalized lifetime progress [0 .. 1]. The era sections
     alone define that 0..1 — the outro track lives past the end of it. */
  const eraCount = Array.from(sections)
    .filter((el) => el.dataset[OUTRO_ATTR] === undefined).length;
  const span = Math.max(1, (eraCount || sections.length) - 1);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Conductor units → TIMELINE units. Linear across the eras, then ONE
     outro section is worth OUTRO_REACH more: the bottom of the page is
     exactly 1 + OUTRO_REACH. Continuous and monotonic at the seam. */
  function normalize(value) {
    if (value <= span) return value / span;
    return 1 + (value - span) * OUTRO_REACH;
  }

  /* The inverse, for the cinema handoff. */
  function denormalize(norm) {
    if (norm <= 1) return norm * span;
    return span + (norm - 1) / OUTRO_REACH;
  }

  const conductor = window.createScrollConductor({
    sections,
    damping: 5.2,
    reducedMotion,
    onUpdate(state) {
      if (external) return;
      TIMELINE.exact = normalize(state.exact);
      TIMELINE.smooth = normalize(state.smooth);
      TIMELINE.active = state.index;
      TIMELINE.direction = state.direction;
      TIMELINE.source = 'scroll';
    },
  });

  /* ---------------- idle detection (ParticleGlobe pattern) ------------- */
  let lastInput = performance.now() / 1000;
  const noteInput = () => { lastInput = performance.now() / 1000; };
  ['pointerdown', 'pointermove', 'wheel', 'touchstart', 'keydown', 'scroll']
    .forEach((type) => addEventListener(type, noteInput, { passive: true }));

  /* ---------------- drag-to-spin (timeport pattern) --------------------- */
  let dragging = false;
  let lastX = 0;
  let lastStamp = 0;
  let dragVel = 0; // rad/s carried into momentum after release

  canvas.addEventListener('pointerdown', (e) => {
    if (suspended) return; // focus mode owns the pointer
    dragging = true;
    dragVel = 0;
    lastX = e.clientX;
    lastStamp = e.timeStamp;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dt = Math.max((e.timeStamp - lastStamp) / 1000, 1e-3);
    lastX = e.clientX;
    lastStamp = e.timeStamp;

    /* Grab-the-world sign: the spiral applies
         rotation.y = -(smooth·TURNS·2π + spinOffset),
       so the cards nearest the camera follow the pointer only when a
       rightward drag DECREASES spinOffset — hence the negative gain.
       Delta is scaled by viewport width so a full sweep is the same
       rotation on every screen. */
    const k = -DRAG_SWEEP / window.innerWidth;
    const dAngle = dx * k;
    TIMELINE.spinOffset += dAngle;
    TIMELINE.source = 'drag';

    const instant = dAngle / dt;
    dragVel += (instant - dragVel) * (1 - Math.exp(-DRAG_SMOOTH_LAMBDA * dt));
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---------------- per-frame integration ------------------------------- */
  let prevSmooth = TIMELINE.smooth;

  function update(dt, nowMs) {
    if (dt <= 0) return;

    const instantaneous = (TIMELINE.smooth - prevSmooth) / dt;
    TIMELINE.velocity +=
      (instantaneous - TIMELINE.velocity) * (1 - Math.exp(-VELOCITY_LAMBDA * dt));
    prevSmooth = TIMELINE.smooth;

    /* momentum + idle drift both hold still while focus has the stage */
    if (!dragging && !suspended && TIMELINE.source !== 'focus') {
      if (dragVel !== 0) {
        TIMELINE.spinOffset += dragVel * dt;
        dragVel += (0 - dragVel) * (1 - Math.exp(-MOMENTUM_LAMBDA * dt));
        if (Math.abs(dragVel) < 1e-4) dragVel = 0;
      }
      // Auto-spin only after true stillness; any input resets the clock.
      if (nowMs / 1000 - lastInput > IDLE_DELAY) {
        TIMELINE.spinOffset += AUTO_RATE * dt;
      }
    }
  }

  /* U8: focus.js raises/lowers this around a staged card. Raising it also
     kills any in-flight drag + momentum so nothing coasts under the stage. */
  function setSuspended(value) {
    suspended = Boolean(value);
    if (suspended) {
      dragging = false;
      dragVel = 0;
      canvas.classList.remove('dragging');
    }
  }

  /* U10: js/cinema.js raises this for the length of a tour. The conductor
     keeps running (it costs nothing while the document cannot move) but
     stops writing TIMELINE — cinema is the only source until it lowers
     again. Velocity below still integrates from d(smooth)/dt, so the cards
     streak on cinema travel exactly as they do on a scroll. */
  function setExternal(value) {
    external = Boolean(value);
  }

  /* U10: place the document at a TIMELINE position and land the conductor
     ON it rather than damping toward it — the seam where cinema hands the
     time back. The anchors are not evenly spaced (the conductor pins the
     first and last to the page ends), so this walks them instead of
     assuming smooth × scrollHeight. */
  function progressToScrollY(norm) {
    const anchors = (conductor.getState().anchors) || [];
    if (anchors.length < 2) return 0;
    const last = anchors.length - 1;
    const e = Math.min(last, Math.max(0, denormalize(norm)));
    const i = Math.min(last - 1, Math.floor(e));
    return anchors[i] + (anchors[i + 1] - anchors[i]) * (e - i);
  }

  function syncTo(norm) {
    const y = progressToScrollY(norm);
    scrollTo({ top: y, behavior: 'auto' });
    conductor.read();                       // exact ← the position just set
    /* The conductor's internal smoothing has no setter; toggling reduced
       motion on and off snaps it onto exact with no tick in between. */
    conductor.setReducedMotion(true);
    conductor.setReducedMotion(reducedMotion);
    TIMELINE.exact = norm;
    TIMELINE.smooth = norm;
    prevSmooth = norm;                      // no phantom velocity spike
    TIMELINE.velocity = 0;
  }

  return {
    conductor, update, setSuspended, setExternal, syncTo, progressToScrollY,
  };
}
