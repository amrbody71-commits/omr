/* cinema.js — U10, the auto-piloted tour. This is the recorder: the user
   runs a screen capture, presses cinema, and gets ~62 seconds of finished
   footage to drop music under.

   THE LOAD-BEARING DECISION: cinema is a second progress SOURCE, not a
   second camera system. It tweens one virtual value and writes it into
   TIMELINE.smooth / TIMELINE.exact every tick with source = 'cinema' —
   from there the world is moved by the exact same pipeline the scroll
   drives (spiral rig → thread → particles → era ledger → outro → focus).
   There is no second camera, no duplicated easing, no parallel look. Every
   polish pass on the interactive site lands in the recording for free, and
   the two can never drift apart because there is only one of them.

   While it runs, js/scroll.js is told to stop writing TIMELINE
   (setExternal) and to stop its drag/idle movers (setSuspended), and the
   document itself is frozen. On exit the document scroll is placed exactly
   where cinema stopped (scroll.syncTo) so the handoff back to the fingers
   is seamless — no rewind, no jump.

   SHAPE OF THE TAKE
     · a dwell at every era's most-representative card (hero, else the
       era's middle memory): the spiral nearly still, a slow parallax drift
       for life,
     · travel between them, eased, duration proportional to the distance,
     · 3 scripted focus beats on hero cards spread across the life —
       cards carrying video are preferred, because a living photo plays
       while it is staged,
     · then the outro to completion, a hold on "to be continued —", and a
       fade to black.

   Nothing else is shown: no progress bar, no controls, no HUD. */

import { gsap } from 'gsap';

/* ---- phase durations (seconds) — see build() for the assembled shape --- */
const DWELL_S = 1.9;          // "rests ~1.6s" plus the settle either side
const TRAVEL_PER_UNIT = 22;   // seconds per unit of TIMELINE distance
const TRAVEL_MIN = 2.6;
const TRAVEL_MAX = 6.2;
const BEAT_STAGE_S = 0.9;     // js/focus.js OPEN_S — the flight to the stage
const BEAT_HOLD_S = 3.2;      // the card held, video playing
const BEAT_CLOSE_S = 0.7;     // js/focus.js CLOSE_S — the flight home
const OUTRO_TRAVEL_S = 6;
const OUTRO_HOLD_S = 3;
const FADE_S = 1.6;
const BLACK_HOLD_S = 2.4;
const REWIND_S = 1.3;         // only when cinema starts away from the top
const FADE_OUT_S = 0.8;       // the black lifting on exit
const BEATS = 3;
const OUTRO_END_FALLBACK = 1.12;

/* Parallax drift: a slow Lissajous, well under the amplitude a hand would
   give it. Silenced under prefers-reduced-motion. */
const DRIFT_X = 0.5;
const DRIFT_Y = 0.3;
const DRIFT_RATE_X = 0.21;
const DRIFT_RATE_Y = 0.146;

/* initCinema({ TIMELINE, scroll, focus, spiral, outro, pointer, flags })
   → { toggle(), start(), stop(), isActive() }

   `pointer` is app.js's live pointer target ({ tx, ty } — app.js damps the
   real values toward it every frame); cinema writes the drift there so the
   parallax rides the SAME path a real hand would. Optional: without it the
   tour simply holds a locked-off camera. */
export function initCinema({
  TIMELINE, scroll, focus, spiral, outro, pointer, flags,
} = {}) {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------- the fade-to-black overlay (built once) ------------- */
  const fade = document.createElement('div');
  fade.id = 'cinema-fade';
  fade.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fade);

  /* ---------------- state ---------------------------------------------- */
  const state = { p: 0 };
  let tl = null;
  let active = false;
  let reduced = mq.matches;
  let prevOverflow = null;
  let lastP = 0;
  let exitedAt = -1e9;
  let targets = [];

  /* ---------------- targets: one dwell per era ------------------------- */
  /* The era's most-representative card is its hero; an era without one
     falls back to its middle memory. Progress of card i is i/(n−1) — the
     same parameterisation js/spiral.js gives it. */
  function buildTargets() {
    const cards = (spiral && spiral.cards) || [];
    const n = cards.length;
    if (!n) return [];
    const byEra = new Map();
    const order = [];
    cards.forEach((card, i) => {
      const id = (card.userData.memory && card.userData.memory.era) || '';
      if (!byEra.has(id)) {
        byEra.set(id, []);
        order.push(id);
      }
      byEra.get(id).push(i);
    });
    /* Walk the eras in the manifest's order where it declares them, then
       anything the manifest never mentioned, in card order. */
    const declared = ((spiral && spiral.eras) || [])
      .map((era) => era.id)
      .filter((id) => byEra.has(id));
    const seen = new Set(declared);
    const ids = declared.concat(order.filter((id) => !seen.has(id)));

    return ids.map((id) => {
      const list = byEra.get(id);
      let index = list[Math.floor(list.length / 2)];
      for (let i = 0; i < list.length; i += 1) {
        const m = cards[list[i]].userData.memory;
        if (m && m.hero) { index = list[i]; break; }
      }
      const memory = cards[index].userData.memory || {};
      return {
        card: cards[index],
        p: n > 1 ? index / (n - 1) : 0,
        hero: !!memory.hero,
        video: !!memory.video,
      };
    }).sort((a, b) => a.p - b.p);
  }

  /* Three beats spread across the life: one per third, hero cards only
     (unless the data has fewer than three), and a card with video wins any
     near-tie — a living photo plays while it is staged. */
  function pickBeats(list) {
    const heroes = list.filter((t) => t.hero);
    const pool = heroes.length >= BEATS ? heroes : list.slice();
    const picks = [];
    for (let b = 0; b < BEATS && picks.length < pool.length; b += 1) {
      const center = (b + 0.5) / BEATS;
      let best = null;
      let bestScore = Infinity;
      for (let i = 0; i < pool.length; i += 1) {
        const t = pool[i];
        if (picks.indexOf(t) !== -1) continue;
        const score = Math.abs(t.p - center) - (t.video ? 0.18 : 0);
        if (score < bestScore) { bestScore = score; best = t; }
      }
      if (best) picks.push(best);
    }
    return picks;
  }

  function outroEnd() {
    return (outro && typeof outro.end === 'number') ? outro.end : OUTRO_END_FALLBACK;
  }

  function travelDur(distance) {
    const d = distance * TRAVEL_PER_UNIT;
    return Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, d));
  }

  /* ---------------- writing the world ---------------------------------- */
  function eraIndexAt(p) {
    let idx = 0;
    for (let i = 0; i < targets.length; i += 1) {
      if (p >= targets[i].p - 1e-6) idx = i;
    }
    return idx;
  }

  /* The ONE write per tick that moves everything. */
  function writeProgress() {
    if (!active) return;
    const p = state.p;
    TIMELINE.smooth = p;
    TIMELINE.exact = p;
    TIMELINE.direction = p >= lastP ? 1 : -1;
    TIMELINE.active = eraIndexAt(p);
    /* focus.js re-asserts 'focus' while a card is staged; it is the truth
       for those seconds and cinema does not argue with it. */
    if (!(focus && focus.isOpen && focus.isOpen())) TIMELINE.source = 'cinema';
    lastP = p;

    if (!reduced && pointer && tl) {
      const t = tl.time();
      pointer.tx = Math.sin(t * DRIFT_RATE_X) * DRIFT_X;
      pointer.ty = Math.cos(t * DRIFT_RATE_Y) * DRIFT_Y;
    }
  }

  /* ---------------- assembly ------------------------------------------- */
  function hold(timeline, seconds) {
    /* A duration-only tween: the playhead advances, nothing is animated,
       and the timeline's onUpdate keeps firing — so dwells still drift. */
    timeline.to(state, { duration: seconds });
  }

  function beat(timeline, card) {
    timeline.call(() => {
      if (!active || !focus || !focus.openCard) return;
      focus.openCard(card);
    });
    hold(timeline, BEAT_STAGE_S + BEAT_HOLD_S);
    timeline.call(() => {
      if (!active) return;
      if (focus && focus.close) focus.close();
      /* focus hands time back the moment it starts closing — but cinema
         still owns it, so take the locks straight back. */
      if (scroll && scroll.setSuspended) scroll.setSuspended(true);
      lockDocument();
    });
    hold(timeline, BEAT_CLOSE_S);
  }

  function build() {
    targets = buildTargets();
    if (!targets.length) return null;
    const beats = pickBeats(targets);
    const travelEase = reduced ? 'power1.inOut' : 'power2.inOut';

    const timeline = gsap.timeline({
      paused: true,
      onUpdate: writeProgress,
      onComplete: () => stop(),
    });

    /* Cinema always plays the whole life. Starting from the middle of the
       page rewinds to the top first — a shot, not a cut. */
    const from = Number.isFinite(TIMELINE.smooth) ? TIMELINE.smooth : 0;
    state.p = from;
    lastP = from;
    if (Math.abs(from - targets[0].p) > 0.015) {
      timeline.to(state, {
        p: targets[0].p,
        duration: REWIND_S,
        ease: 'power2.inOut',
      });
    } else {
      state.p = targets[0].p;
    }

    for (let i = 0; i < targets.length; i += 1) {
      if (i > 0) {
        timeline.to(state, {
          p: targets[i].p,
          duration: travelDur(Math.abs(targets[i].p - targets[i - 1].p)),
          ease: travelEase,
        });
      }
      hold(timeline, DWELL_S);
      if (beats.indexOf(targets[i]) !== -1) beat(timeline, targets[i].card);
    }

    /* The ending, driven through the same value: js/outro.js is watching
       TIMELINE.smooth and needs no cue of its own. */
    timeline.to(state, {
      p: outroEnd(),
      duration: OUTRO_TRAVEL_S,
      ease: 'power1.inOut',
    });
    hold(timeline, OUTRO_HOLD_S);
    timeline.call(() => showFade(true));
    hold(timeline, FADE_S + BLACK_HOLD_S);

    return timeline;
  }

  /* ---------------- locks ---------------------------------------------- */
  /* The same lock focus.js and the intro use: html overflow + scroll.js's
     suspension switch. Nested safely — focus.js may take and give back its
     own copy inside a beat. */
  function lockDocument() {
    if (prevOverflow === null) prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  function unlockDocument() {
    if (prevOverflow === null) return;
    document.documentElement.style.overflow = prevOverflow;
    prevOverflow = null;
  }

  function showFade(on) {
    fade.style.transitionDuration = (on ? FADE_S : FADE_OUT_S) + 's';
    fade.classList.toggle('on', !!on);
  }

  /* ---------------- exits ----------------------------------------------- */
  function onKey(e) {
    if (e.key === 'Escape') stop();
  }
  /* Capture phase: the click that ends the tour must not also land on the
     canvas underneath (focus.js would stage whatever card was under it,
     scroll.js would start a drag). Stopping it here costs nothing else —
     every other pointer path is already suspended. */
  function onPointerDown(e) {
    e.stopPropagation();
    stop();
  }
  function addExits() {
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onPointerDown, true);
  }
  function removeExits() {
    removeEventListener('keydown', onKey);
    removeEventListener('pointerdown', onPointerDown, true);
  }

  /* ---------------- start / stop ---------------------------------------- */
  function start() {
    if (active) return;
    if (!spiral || !spiral.cards || !spiral.cards.length) return;
    reduced = mq.matches;   // re-read: the preference can change mid-session
    active = true;

    /* A card staged by hand is not part of the take — and it must be closed
       BEFORE the lock is taken: focus.js is holding the document's original
       overflow value, and giving it back after cinema saved 'hidden' would
       leave the page frozen for good when the tour ends. */
    if (focus && focus.isOpen && focus.isOpen() && focus.close) focus.close();

    document.body.classList.add('cinema-mode');
    showFade(false);   // a previous take's black may still be lifting
    lockDocument();
    if (scroll) {
      if (scroll.setExternal) scroll.setExternal(true);
      if (scroll.setSuspended) scroll.setSuspended(true);
    }

    tl = build();
    if (!tl) {
      active = false;
      unlockDocument();
      document.body.classList.remove('cinema-mode');
      if (scroll && scroll.setExternal) scroll.setExternal(false);
      if (scroll && scroll.setSuspended) scroll.setSuspended(false);
      return;
    }
    addExits();
    if (flags && flags.stats) {
      console.info('[omr] cinema: ' + tl.duration().toFixed(1) + 's, ' +
        targets.length + ' dwells');
    }
    tl.play(0);
  }

  function stop() {
    if (!active) return;
    active = false;
    exitedAt = performance.now();
    removeExits();

    if (tl) {
      tl.kill();
      tl = null;
    }
    gsap.killTweensOf(state);

    /* Close BEFORE the document lock is handed back: focus.js restores the
       overflow value IT saw (cinema's 'hidden'), and unlockDocument then
       restores the one from before the tour. */
    if (focus && focus.isOpen && focus.isOpen() && focus.close) focus.close();

    document.body.classList.remove('cinema-mode');
    showFade(false);
    unlockDocument();

    /* The handoff: the page is placed exactly where the tour stopped, and
       the conductor is snapped (not damped) onto it — so the first scrolled
       pixel continues from here instead of rewinding. */
    const at = Math.min(outroEnd(), Math.max(0, TIMELINE.smooth));
    if (scroll) {
      if (scroll.setExternal) scroll.setExternal(false);
      if (scroll.syncTo) scroll.syncTo(at);
      if (scroll.setSuspended) scroll.setSuspended(false);
    }
    TIMELINE.source = 'scroll';
    if (pointer) {
      pointer.tx = 0;
      pointer.ty = 0;
    }
  }

  function toggle() {
    if (active) {
      stop();
      return;
    }
    /* The click that just exited also fires the button's own click — it
       must not turn the tour straight back on. */
    if (performance.now() - exitedAt < 400) return;
    start();
  }

  return {
    toggle,
    start,
    stop,
    isActive() {
      return active;
    },
  };
}
