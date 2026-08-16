/* app.js — the spine: renderer, scene, camera, the one rAF loop, and the
   TIMELINE state every other module reads or writes. */

import * as THREE from 'three';
import { initScroll } from './scroll.js';
import { createSpiral, RADIUS } from './spiral.js';
import { initThread } from './thread.js';
import { initParticles } from './particles.js';
import { initMist } from './mist.js';
import { initMistField } from './mistfield.js';
import { initCore } from './core.js';
import { initEras, sample as sampleEras } from './eras.js';
import { initHud, update as updateHud } from './hud.js';
import { initFocus } from './focus.js';
import { initPost } from './post.js';
import { initOutro, OUTRO_END } from './outro.js';
import { initCinema } from './cinema.js';
import { TIERS, createGovernor, buildLadder } from './quality.js';

/* Boot placeholder only — from the first applied frame on, the era ledger
   (js/eras.js) owns camera radius, lens, fog and exposure. */
const CAM_RADIUS = 26;

/* Shared clock of the whole site. `smooth` drives everything visual,
   `exact` anything that must be correct rather than pretty. */
export const TIMELINE = {
  exact: 0,
  smooth: 0,
  velocity: 0,
  spinOffset: 0,
  active: 0,
  direction: 0,
  source: 'scroll',
};

export async function start() {
  const flags = window.OMR_FLAGS || {};
  /* U7: boot.js resolves the tier object; a direct app.js start (tests,
     console) falls back to the shipped default. */
  const quality = flags.quality || TIERS.high;
  const canvas = document.getElementById('scene');
  const small = innerWidth < 760;

  /* ---------------- renderer (duat pattern) ---------------- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !small,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    throw new Error('This page needs WebGL, and the browser would not give it up.');
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality.dpr));
  /* These two drive the direct-render (?post=0) path. Inside the U6
     composer three compiles render-target materials with NoToneMapping +
     linear output, so they go inert there and js/post.js applies the SAME
     ACES + sRGB exactly once at the end of the chain — never twice. */
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* preventDefault is required or the browser never fires the restore event. */
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[omr] WebGL context lost — waiting for restore.');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => location.reload(), false);

  /* ---------------- scene & camera ---------------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101226');
  scene.fog = new THREE.Fog('#2A2140', CAM_RADIUS + 4, CAM_RADIUS + 50);

  const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 220);
  /* World-moves rig: the camera holds this post forever; the spiral group
     rotates and sinks past it. Only parallax pans the eye — the era ledger
     breathes radius/height/tilt around the post each frame. */
  camera.position.set(0, 0, CAM_RADIUS);
  camera.lookAt(0, 0, 0);

  /* ---------------- pointer (duat normalization) ---------------- */
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });

  /* ---------------- world ---------------- */
  /* renderer rides along for texture caps (anisotropy) in js/textures.js;
     quality carries card subdivision + the texture residency window. */
  const spiral = await createSpiral(scene, { renderer, quality });

  /* ---------------- U5: thread of light + deep space ---------------- */
  /* Thread and fireflies live INSIDE spiral.group — the world rig moves
     them for free. Stars and nebulae are world-static, added to the scene.
     Particle counts come from the quality tier (U7). */
  const thread = initThread(spiral.group);
  const particles = initParticles(scene, spiral.group, quality);

  /* ---------------- the spine: era ink eruptions ----------------
     Curl-noise ink born ON the thread and thrown outward far enough to
     reach the card ring (11.4 + 3.4/1.15 ≈ 14.36 vs cards at 14.0), so
     plumes wrap the photographs rather than hazing behind them. Tinted by
     the era each particle is born into; erupts at every era boundary. */
  /* Two inks, one interface: v1 is the GPGPU particle field, v2 the static
     photographic billboards the reference actually uses. ?mist=v2 swaps
     them — every call site below is identical either way. */
  const mist = flags.mist === 'v2'
    ? initMistField(scene, spiral.group, quality, { renderer })
    : initMist(scene, spiral.group, quality, { renderer });
  mist.setEraColors(spiral.eras.map((era) => era.tint));

  /* ---------------- the spindle: the core on the axis ----------------
     World-static, so the spiral visibly TURNS on it — that is what makes
     the rotation legible and fills the hollow middle. Machined rings
     against the organic ink: the contrast is the point. The ring nearest
     the current year burns in its era colour, so the core also quietly
     says where in the life you are. */
  const core = initCore(scene, quality, { renderer });
  core.setEraColors(spiral.eras.map((era) => era.tint));

  /* ---------------- U6: cinematic post chain ---------------- */
  /* The composer owns ACES + sRGB from here on (see js/post.js header for
     the no-double-apply proof); ?post=0 keeps the pre-U6 direct-render
     path for A/B. Bloom is the tier's call (U7). */
  let post = null;
  if (flags.post) {
    post = initPost(renderer, scene, camera, { bloom: quality.bloom });
  }

  /* ---------------- era ledger (U2) ---------------- */
  const data = { eras: spiral.eras, memories: spiral.memories };
  initEras(data);
  /* Snap the lens to the ledger's opening row so frame one is composed —
     the per-frame lerp then only ever eases between rows. */
  camera.fov = sampleEras(TIMELINE.smooth).fov;
  camera.updateProjectionMatrix();
  let appliedFov = camera.fov;

  // ?axes debug helpers (?grid is reserved for the U7 static-grid fallback)
  if (flags.axes) {
    scene.add(new THREE.GridHelper(60, 30, 0xFFB865, 0x2A2140));
    scene.add(new THREE.AxesHelper(8));
  }

  /* ---------------- U10: the outro zone ----------------
     One more track past the last memory, appended BEFORE the conductor
     measures anything. It is marked data-outro so js/scroll.js keeps it out
     of the era span: the eras still map to smooth ∈ [0,1] exactly as
     before, and this section alone carries smooth from 1 to OUTRO_END. */
  const trackHost = document.querySelector('main');
  if (trackHost) {
    const outroTrack = document.createElement('section');
    outroTrack.className = 'era-track outro-track';
    outroTrack.dataset.outro = '1';
    outroTrack.setAttribute('aria-hidden', 'true');
    trackHost.appendChild(outroTrack);
  }

  const scroll = initScroll(TIMELINE, canvas);

  /* ---------------- HUD (U2 instrument cluster) ---------------- */
  initHud(data, {
    onEraClick: (index) => scroll.conductor.goTo(index),
  });

  /* ---------------- U8: photo focus mode ---------------- */
  /* Click/tap a card → it flies to a camera-locked stage. While open
     (TIMELINE.source === 'focus') the document scroll is frozen and
     drag-spin + idle-spin are suspended via scroll.setSuspended — the
     gates live in scroll.js so every time mover halts at one switch. */
  const focus = initFocus({
    camera,
    scene,
    spiral,
    TIMELINE,
    conductor: scroll.conductor,
    canvas,
    scroll,
  });

  /* ---------------- U10: the ending + the tour ----------------
     outro.js watches TIMELINE.smooth past 1 and needs no cue of its own;
     cinema.js is a SECOND SOURCE for that same value — while it runs the
     conductor stops writing (scroll.setExternal) and every system below
     keeps working from the one number, unaware anything changed. */
  const outro = initOutro({ camera, scene, spiral, thread, particles });
  const cinema = initCinema({
    TIMELINE, scroll, focus, spiral, outro, pointer, flags,
  });

  /* ?stats doubles as the debug build: expose live handles for the
     orchestrated browser checks (never present in normal visits). */
  if (flags.stats) {
    window.OMR_DEBUG = {
      TIMELINE, spiral, camera, focus, scroll, renderer, scene, quality,
      outro, cinema, OUTRO_END, mist, core, thread, particles, post,
    };
  }

  /* ---------------- U9: intro sequence ----------------
     js/intro.js is loaded dynamically AFTER the first frame, so the boot
     path never waits on it. Everything here is written so that any failure
     — bad import, no float render targets, a thrown handler — lands in the
     same done state the natural end lands in: scroll unlocked, exposure
     multiplier 1, camera offset 0, HUD visible. The site never wedges. */
  let intro = null;
  /* The opening plays on EVERY load. It was once-per-session, which is the
     right instinct for a site you return to and the wrong one for a nine
     second film that is half the piece — a refresh should start the story
     over. ?intro=0 skips it (the cinema tour and the static grid pass it),
     and the skip control still ends it on any frame. */
  const wantsIntro = flags.intro !== null && flags.intro !== undefined
    ? flags.intro
    : !flags.grid;
  let introPending = wantsIntro;   // dark-hold while intro.js is in flight
  let introPrevOverflow = null;

  /* 1 whenever there is no intro to answer for. */
  function introExposureScale() {
    if (intro) return intro.getExposureScale();
    return introPending ? 0.06 : 1;
  }

  /* Same lock focus.js uses (js/focus.js): html overflow + the scroll.js
     suspension switch that halts drag-spin, momentum and idle drift. */
  function lockIntroScroll() {
    if (introPrevOverflow !== null) return;
    introPrevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    scroll.setSuspended(true);
  }
  function unlockIntroScroll() {
    if (introPrevOverflow === null) return;
    document.documentElement.style.overflow = introPrevOverflow;
    introPrevOverflow = null;
    scroll.setSuspended(false);
  }

  /* ---------------- U10: cinema controls ----------------
     One toggle, three ways in: the HUD button, the C key, and ?cinema=1 —
     which waits for the intro to hand over, so ?cinema=1&intro=1 is the
     full take, opening titles included. The tour refuses to start under the
     intro: until it is done the intro owns exposure and the scroll lock. */
  let cinemaAutoStarted = false;

  function toggleCinema() {
    if (introPending) return;
    cinema.toggle();
  }

  function maybeStartCinema() {
    if (!flags.cinema || cinemaAutoStarted) return;
    cinemaAutoStarted = true;
    /* a breath after the handoff, so the take does not open on a HUD
       caught halfway through its fade-in */
    setTimeout(() => {
      if (!cinema.isActive()) cinema.start();
    }, 700);
  }

  const cinemaBtn = document.getElementById('cinema-btn');
  if (cinemaBtn) cinemaBtn.addEventListener('click', toggleCinema);

  addEventListener('keydown', (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // never steal a copy
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    toggleCinema();
  });

  /* The one done state — natural end, skip, watchdog and thrown handler all
     land here: scroll unlocked, exposure multiplier 1, HUD visible. U10
     hands straight over to ?cinema=1 from the same place. */
  function finishIntro() {
    introPending = false;
    document.body.classList.remove('intro-playing');
    unlockIntroScroll();
    /* Judge the steady state, not the set piece — and give the first
       frames back their grace period (the handoff still carries the
       intro's last compiles). */
    governor.setSuspended(false, performance.now());
    maybeStartCinema();
  }

  /* ---------------- resize ---------------- */
  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    /* composer sees the size already applied and only resizes its own
       buffers (drawing-buffer size, so DPR is accounted for) */
    if (post) post.setSize(innerWidth, innerHeight);
  }
  resize();
  addEventListener('resize', resize);

  /* ---------------- U7: runtime governor (demote-only) ----------------
     Sampled every rAF; a sustained sub-50fps average steps ONE rung down
     the ladder (dpr → bloom → particle density), never back up. The
     ladder is built from what THIS run actually has to give back —
     ?post=0 means there is no bloom pass to cut, so that rung is elided. */
  const governor = createGovernor({
    ladder: buildLadder({ ...quality, bloom: quality.bloom && !!post }),
    onDemote(step) {
      if (step === 'dpr') {
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
        resize();   // renderer + composer buffers pick up the new ratio
      } else if (step === 'bloom' && post) {
        post.setBloom(false);
      } else if (step === 'density') {
        particles.setDensity(0.5);
        mist.setDensity(0.5);   // the heaviest layer sheds first
      }
      console.info('[omr] governor: demoted →', step);
    },
  });

  /* ---------------- ?shot: blit to a 2D canvas ----------------
     A WebGL canvas captures as black in screenshots (no preserved buffer);
     copying the freshly-rendered frame into an overlaid 2D canvas inside the
     same rAF callback gives screenshot tools real pixels to read. */
  let blit = null;
  if (flags.shot) {
    const shot = document.createElement('canvas');
    shot.id = 'shot-blit';
    shot.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2;';
    document.body.appendChild(shot);
    const ctx = shot.getContext('2d');
    blit = () => {
      /* A zero-sized drawing buffer (a pane that opens collapsed, a hidden
         tab) makes drawImage throw — and this is a debug aid, so it must
         never be the thing that takes the site down. */
      if (!canvas.width || !canvas.height) return;
      if (shot.width !== canvas.width || shot.height !== canvas.height) {
        shot.width = canvas.width;
        shot.height = canvas.height;
      }
      ctx.clearRect(0, 0, shot.width, shot.height);
      ctx.drawImage(canvas, 0, 0);
    };
  }

  /* ---------------- ?stats overlay ---------------- */
  let stats = null;
  if (flags.stats) {
    const el = document.createElement('div');
    el.id = 'stats';
    el.style.cssText =
      'position:fixed;top:52px;left:24px;z-index:4;pointer-events:none;' +
      'font:10px/1.6 "Spline Sans Mono",monospace;letter-spacing:.08em;' +
      'color:#FFE9C4;white-space:pre;';
    document.body.appendChild(el);
    let frames = 0;
    let lastReport = performance.now();
    stats = (now) => {
      frames += 1;
      if (now - lastReport < 500) return; // 2 updates/sec
      const fps = (frames * 1000) / (now - lastReport);
      const info = renderer.info.render;
      const tex = spiral.stats();
      const gov = governor.state();
      el.textContent =
        fps.toFixed(0) + ' fps\n' +
        info.calls + ' calls · ' + info.triangles + ' tris\n' +
        'smooth ' + TIMELINE.smooth.toFixed(3) +
        ' · spin ' + TIMELINE.spinOffset.toFixed(2) + '\n' +
        'tex ' + tex.resident + ' resident · ' + tex.loading + ' loading\n' +
        'pts ' + particles.count + '\n' +
        'post ' + (post ? 'on' : 'off') +
        ' · bloom ' + (post && post.bloom ? 'on' : 'off') + '\n' +
        'tier ' + quality.name + ' · gov ' + gov.demotions + ' demotion' +
        (gov.demotions === 1 ? '' : 's') +
        (gov.demotions ? ' (' + gov.applied + ')' : '');
      frames = 0;
      lastReport = now;
    };
  }

  /* ---------------- ledger application (every frame) ----------------
     Reads the interpolated era frame and writes camera, atmosphere, card
     tint and HUD. Writes go into EXISTING objects — zero allocation. */
  let lastMistEra = -1;

  function applyLedger(dt) {
    const f = sampleEras(TIMELINE.smooth);

    /* FRAMING: the focused card hangs at z = RADIUS = 14, so the true
       subject distance is camRadius − RADIUS ≈ 11.4–13 — the 4.2-unit card
       fills ~40–42% of viewport height at fov 44–48. Portrait screens
       would overfill, so below aspect 1.4 the distance-from-card stretches
       by (1.4/aspect)^0.5 (clamped ×1.35): narrow screens pull back
       instead of cropping the card. */
    const fit = camera.aspect < 1.4
      ? Math.min(Math.sqrt(1.4 / camera.aspect), 1.35)
      : 1;
    const camZ = RADIUS + (f.camRadius - RADIUS) * fit;

    /* Parallax pans (offsets eye AND target so the shot never dollies);
       the ledger then lifts the eye (camHeightOffset > 0) and pitches it
       gently DOWN (tilt < 0) into the era rising from below. settle stays
       1 until a later unit wires the transition-aware fade. */
    const settle = 1;
    const px = pointer.x * 0.9 * settle;
    const py = pointer.y * 0.5 * settle;
    /* U9: the intro holds the eye ~10 units high and lowers it into this
       pose as the knot detonates. Zero once the intro is done or absent. */
    const introY = intro ? intro.getCameraOffsetY() : 0;
    camera.position.set(px, -py + f.camHeightOffset + introY, camZ);
    camera.lookAt(px * 0.55, -py * 0.55, 0);
    camera.rotateX(f.tilt);

    /* Lens eases toward the row value; the projection matrix is rebuilt
       only when the fov has actually moved. */
    camera.fov += (f.fov - camera.fov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(camera.fov - appliedFov) > 0.01) {
      appliedFov = camera.fov;
      camera.updateProjectionMatrix();
    }

    /* Atmosphere: written into the existing Color/Fog instances. */
    scene.background.copy(f.world.bg);
    scene.fog.color.copy(f.world.fog);
    scene.fog.near = f.world.fogNear;
    scene.fog.far = f.world.fogFar;
    /* U9: the intro's ignition ramp is a MULTIPLIER on the ledger's own
       exposure — the world sits at ~6% until the knot detonates. The intro
       particles pre-divide by the same factor, so only the world dims. */
    const exposure = f.world.exposure * introExposureScale();
    if (post) {
      /* setExposure routes through renderer.toneMappingExposure, which the
         FilmGrade ACES reads via the renderer-managed uniform (post.js). */
      post.setExposure(exposure);
      post.setEraTemp(f.world.colorTemp);
    } else {
      renderer.toneMappingExposure = exposure;
    }

    spiral.setEraTint(f.world.eraTint);
    particles.setEraTint(f.world.eraTint);
    mist.update(TIMELINE, f, dt);

    /* Era boundary → one eruption. Same index expression hud.js uses, so
       the ink detonates on the exact frame the year span decodes. */
    let eraIdx = TIMELINE.active;
    if (!Number.isInteger(eraIdx) || eraIdx < 0 || eraIdx >= spiral.eras.length) {
      eraIdx = spiral.eras.length > 1
        ? Math.round(TIMELINE.smooth * (spiral.eras.length - 1)) : 0;
    }
    if (eraIdx !== lastMistEra) {
      if (lastMistEra >= 0) mist.pulse(1.0);
      lastMistEra = eraIdx;
    }

    updateHud(TIMELINE, f);
    /* U10: the outro reads the row it should sit on top of. */
    return f;
  }

  let endingShown = false;

  /* ---------------- the one frame loop ---------------- */
  let last = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    /* clamped: a backgrounded tab returns with a huge dt */
    const dt = Math.min(Math.max(now - last, 0), 50) / 1000;
    last = now;
    step(dt, now);
  }

  /* One frame's worth of work, callable without rAF. A hidden tab (an
     automated pane, a background window) parks requestAnimationFrame, so
     verification needs a way to advance the world by hand. */
  function step(dt, now) {

    /* dt-correct exponential decay — the only damping form allowed here;
       `x += (target-x)*k` per frame silently runs twice as fast at 120Hz. */
    const kP = 1 - Math.exp(-2.6 * dt);
    pointer.x += (pointer.tx - pointer.x) * kP;
    pointer.y += (pointer.ty - pointer.y) * kP;

    /* Time itself: normally the conductor writes TIMELINE from the document
       scroll — while a cinema tour is running it has already stopped
       (scroll.setExternal), and this call only keeps integrating velocity
       from d(smooth)/dt, which is what makes cinema travel streak the cards
       exactly like a scroll does. */
    scroll.update(dt, now);
    /* dt drives uTime + the velocity feed; pointer lands in the cards'
       shared uPointer uniform for depth parallax. */
    spiral.update(TIMELINE, dt, pointer);
    thread.update(TIMELINE, dt);
    particles.update(TIMELINE, dt);
    /* BEFORE applyLedger: the intro's GPGPU step runs here (it restores the
       render target itself), and the ledger reads its exposure + camera Y. */
    if (intro) intro.update(dt);
    const ledger = applyLedger(dt);
    core.update(TIMELINE, ledger, dt);
    /* AFTER applyLedger (it writes camera, fog and background from the era
       row) and BEFORE focus: past smooth = 1 the outro layers its ending on
       top of that row — and a staged card must still win over it. */
    outro.update(TIMELINE, ledger, dt);
    /* The instrument HUD stands down for the ending — past the halfway
       point of the outro the only words left on screen are its own. */
    /* A staged photograph gets a quiet room: the ink drops back so it is
       atmosphere behind the glass, never competition in front of it. */
    mist.setIntensity(focus.isOpen() ? 0.15 : 1);

    const ending = outro.progress() > 0.42;
    if (ending !== endingShown) {
      endingShown = ending;
      document.body.classList.toggle('outro-open', ending);
    }
    /* AFTER spiral.update (it owns uLit + the group transform) and AFTER
       applyLedger (the camera pose is final): focus stages its card and
       projects the DOM reticle against THIS frame's matrices. */
    focus.update(dt);

    if (post) post.render(dt);
    else renderer.render(scene, camera);
    /* blit AFTER the chain: the final pass composes onto the canvas, so
       drawImage still captures the finished frame */
    if (blit) blit();
    governor.sample(now);
    if (stats) stats(now);
  }

  if (flags.stats && window.OMR_DEBUG) {
    /* Advance the world by hand: OMR_DEBUG.step(0.016) renders one frame
       even when the tab is hidden and rAF is parked. */
    window.OMR_DEBUG.step = (dt = 0.016) => step(dt, performance.now());
  }

  /* First frame before the ready signal, so the loader never lifts onto
     an unpainted canvas — ledger applied so frame one is already graded. */
  spiral.update(TIMELINE, 0, pointer);
  thread.update(TIMELINE, 0);
  particles.update(TIMELINE, 0);
  const bootFrame = applyLedger(0);
  core.update(TIMELINE, bootFrame, 0);
  outro.update(TIMELINE, bootFrame, 0);
  if (post) post.render(0);
  else renderer.render(scene, camera);
  if (blit) blit();
  requestAnimationFrame(frame);

  scroll.conductor.start();

  /* Class + lock go up BEFORE the ready signal, so the loader never lifts
     onto a visible HUD that is about to be hidden. */
  if (wantsIntro) {
    document.body.classList.add('intro-playing');
    lockIntroScroll();
    governor.setSuspended(true);   // the opening is a set piece, not the site
  }

  dispatchEvent(new CustomEvent('omr:ready'));

  /* No intro to wait on — ?cinema=1 starts the take from here. */
  if (!wantsIntro) maybeStartCinema();

  if (wantsIntro) {
    /* A stalled module fetch is the one way this could hold the world dark
       forever — so it can't: the watchdog hands the site over regardless. */
    let abandoned = false;
    const watchdog = setTimeout(() => {
      abandoned = true;
      console.warn('[omr] intro did not load in time — handing over.');
      finishIntro();
    }, 3500);
    try {
      const { initIntro } = await import('./intro.js');
      if (abandoned) throw new Error('intro abandoned by the watchdog');
      clearTimeout(watchdog);
      intro = initIntro({ renderer, scene, camera, quality });
      intro.onDone(finishIntro);
      intro.start();
    } catch (err) {
      clearTimeout(watchdog);
      console.warn('[omr] intro skipped:', err);
      /* If it got far enough to exist, tear it down — an intro that was
         built but never started would otherwise hold the world at 6%. */
      if (intro && intro.dispose) {
        try {
          intro.dispose();
        } catch (inner) {
          console.warn('[omr] intro dispose failed:', inner);
        }
      }
      intro = null;
      finishIntro();
    }
  }
}
