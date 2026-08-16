/* focus.js — U8 photo focus mode: click a memory and the helix holds its
   breath. The card GSAP-flies from its helix home to a camera-locked stage
   slot; every other card dims and soft-blurs through the shared uFocus
   shader hook; a DOM reticle (corner brackets, a one-shot scan sweep, a
   decoding year readout) locks around the staged card like an archive
   scanner reading a slide.

   Space bookkeeping: the stage slot is computed ONCE per open in WORLD
   space from the live camera (card fills ≈ 62% of viewport height, -4°
   lean-back, right-of-center on desktop). The card is never reparented —
   each frame the world slot is pulled into the spiral group's CURRENT
   local space and the card blends home↔slot by one eased progress value:
   p = 0 is always exactly its helix home (helixAt(t), the group-local
   truth), p = 1 always exactly the slot. A still-settling — or, on close,
   freshly re-scrolled — helix can therefore never strand the card.

   CAPTIONS ARE INTENTIONALLY ABSENT: the readout is year + era + archive
   coords only. memory.title feeds the dialog aria-label and nothing else.

   Video (living photo): memory.video may be null (no video UI at all) or
   a path — then ONE <video> + VideoTexture per open are created, mixed in
   through the card shader's uVideo/uVideoMix path, and fully disposed on
   close (texture, element, tweens), so renderer.info.memory.textures
   returns to baseline. */

import * as THREE from 'three';
import { gsap } from 'gsap';
import { helixAt } from './spiral.js';
import { scrambleTo } from './hud.js';

const SEP = '∕';                    // division slash — hud.js's fraction mark
const FILL_H = 0.62;                // staged card ≈ 62% of viewport height
const TILT = (-4 * Math.PI) / 180;  // slight lean-back for depth
const NDC_X_DESKTOP = 0.14;         // right-of-center on landscape screens
const NDC_Y = 0.02;                 // a breath above true center
const EDGE_NDC = 0.94;              // card + offset must stay inside ±0.94
const CLICK_SLOP = 6;               // px of travel that still reads as a click
const OPEN_S = 0.9;
const CLOSE_S = 0.7;

/* Preallocated temps — zero allocation per frame. */
const mInv = new THREE.Matrix4();
const vTarget = new THREE.Vector3();
const qGroupInv = new THREE.Quaternion();
const qTarget = new THREE.Quaternion();
const vCorner = new THREE.Vector3();
const vRight = new THREE.Vector3();
const vUp = new THREE.Vector3();
const vFwd = new THREE.Vector3();
const nPointer = new THREE.Vector2();
const qTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(TILT, 0, 0));

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* initFocus({ camera, scene, spiral, TIMELINE, conductor, canvas, scroll })
   → { update(dt), isOpen() }. `scroll` carries setSuspended (drag/idle
   freeze); the conductor keeps its own rAF and simply has nothing to do
   while the document can't move. */
export function initFocus({ camera, scene, spiral, TIMELINE, conductor, canvas, scroll } = {}) {
  const cards = spiral.cards;
  const group = spiral.group;
  const uFocus = spiral.uFocus;
  const memoryCount = spiral.memories.length;
  const eraById = new Map((spiral.eras || []).map((e) => [e.id, e]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const raycaster = new THREE.Raycaster();

  /* ---------------- overlay DOM — built ONCE, reused every open --------- */
  const overlay = document.createElement('div');
  overlay.id = 'focus-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const frame = document.createElement('div');
  frame.className = 'fo-frame';
  frame.setAttribute('role', 'dialog');
  ['tl', 'tr', 'bl', 'br'].forEach((k) => {
    const c = document.createElement('span');
    c.className = 'fo-corner ' + k;
    frame.appendChild(c);
  });
  const scan = document.createElement('div');
  scan.className = 'fo-scan';
  frame.appendChild(scan);

  const readout = document.createElement('div');
  readout.className = 'fo-readout';
  const yearEl = document.createElement('div');
  yearEl.className = 'fo-year';
  const eraEl = document.createElement('div');
  eraEl.className = 'fo-era';
  const metaEl = document.createElement('div');
  metaEl.className = 'fo-meta';
  readout.append(yearEl, eraEl, metaEl);
  frame.appendChild(readout);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'fo-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close memory');
  frame.appendChild(closeBtn);

  overlay.appendChild(frame);
  document.body.appendChild(overlay);

  /* ---------------- sessions -------------------------------------------- */
  /* A session tracks one card's journey off and back onto the helix.
     `staged` is the open one; `returning` holds cards still flying home
     (a rapid open of another card must not teleport the last one). */
  let staged = null;
  const returning = new Set();
  let hideTimer = 0;
  let prevHtmlOverflow = null;

  function makeSession(card) {
    const { angle, y, radius } = helixAt(card.userData.t); // deterministic home
    return {
      card,
      memory: card.userData.memory,
      homePos: new THREE.Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius),
      homeQuat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, angle, 0)),
      worldPos: new THREE.Vector3(),
      worldQuat: new THREE.Quaternion(),
      p: { v: 0 },      // 0 = home, 1 = stage slot (the ONE tweened value)
      closing: false,
      video: null,
      videoTexture: null,
      videoPrev: null,  // uVideo binding to restore (the card's placeholder)
    };
  }

  /* ---------------- stage-slot math (world space, once per open) -------- */
  function computeStageSlot(session) {
    camera.updateMatrixWorld();
    const geo = session.card.geometry.parameters;
    const tanH = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = camera.aspect;
    const xOff = aspect >= 1.05 ? NDC_X_DESKTOP : 0; // desktop right-of-center

    /* Distance so the card spans FILL_H of the viewport height … */
    let d = geo.height / (2 * tanH * FILL_H);
    /* … pulled back if the card + lateral offset would spill past ±EDGE_NDC
       horizontally (portrait screens, landscape photos). */
    const dMinW = (geo.width / 2) / (Math.max(0.05, EDGE_NDC - xOff) * tanH * aspect);
    if (dMinW > d) d = dMinW;

    const e = camera.matrixWorld.elements;
    vRight.set(e[0], e[1], e[2]).normalize();
    vUp.set(e[4], e[5], e[6]).normalize();
    vFwd.set(e[8], e[9], e[10]).normalize().multiplyScalar(-1); // camera looks down -Z

    session.worldPos
      .copy(camera.position)
      .addScaledVector(vFwd, d)
      .addScaledVector(vRight, xOff * d * tanH * aspect)
      .addScaledVector(vUp, NDC_Y * d * tanH);
    session.worldQuat.copy(camera.quaternion).multiply(qTilt); // face camera, -4° lean
  }

  /* Per-frame: pull the fixed WORLD slot into the group's CURRENT local
     space and blend home↔slot by the session's eased progress. */
  function applySession(session) {
    mInv.copy(group.matrixWorld).invert();
    vTarget.copy(session.worldPos).applyMatrix4(mInv);
    qGroupInv.copy(group.quaternion).invert();
    qTarget.copy(qGroupInv).multiply(session.worldQuat);
    session.card.position.lerpVectors(session.homePos, vTarget, session.p.v);
    session.card.quaternion.slerpQuaternions(session.homeQuat, qTarget, session.p.v);
    /* mid-flight cards stay lit — hands back to the helix falloff as p→0 */
    const uLit = session.card.userData.uLit;
    if (session.p.v > uLit.value) uLit.value = session.p.v;
  }

  /* ---------------- scroll lock (mandated form) -------------------------- */
  function lockScroll() {
    if (prevHtmlOverflow !== null) return; // already locked
    const html = document.documentElement;
    prevHtmlOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
  }
  function unlockScroll() {
    if (prevHtmlOverflow === null) return;
    document.documentElement.style.overflow = prevHtmlOverflow;
    prevHtmlOverflow = null;
  }

  /* ---------------- living photo (video) -------------------------------- */
  function startVideo(session) {
    const src = session.memory && session.memory.video;
    if (!src) return; // video:null → photo only, no video UI of any kind
    const el = document.createElement('video');
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    session.video = el;
    el.addEventListener('canplay', () => {
      /* the open may have been torn down before the decoder was ready */
      if (session.closing || session.video !== el) return;
      const tex = new THREE.VideoTexture(el);
      tex.colorSpace = THREE.SRGBColorSpace;
      session.videoTexture = tex;
      const uniforms = session.card.material.uniforms;
      session.videoPrev = uniforms.uVideo.value; // the card's placeholder
      uniforms.uVideo.value = tex;
      const play = el.play();
      if (play && play.catch) play.catch(() => {});
      gsap.to(uniforms.uVideoMix, {
        value: 1,
        duration: reduced ? 0.1 : 0.6,
        ease: 'power2.out',
        overwrite: true,
      });
    }, { once: true });
    el.addEventListener('error', () => {}, { once: true }); // missing file → photo stays, silently
    el.src = src;
    el.load();
  }

  function stopVideo(session, immediate) {
    const uniforms = session.card.material.uniforms;
    const finish = () => {
      uniforms.uVideoMix.value = 0;
      if (session.videoTexture) {
        /* only restore the binding we own — a rapid re-open of the same
           card may already have swapped in a fresh texture */
        if (uniforms.uVideo.value === session.videoTexture) {
          uniforms.uVideo.value = session.videoPrev;
        }
        session.videoTexture.dispose();
        session.videoTexture = null;
      }
      if (session.video) {
        session.video.pause();
        session.video.removeAttribute('src');
        session.video.load(); // release the decoder + network slot
        session.video = null;
      }
    };
    if (!session.video && !session.videoTexture) return;
    if (!immediate && !reduced && uniforms.uVideoMix.value > 0.001) {
      gsap.to(uniforms.uVideoMix, {
        value: 0,
        duration: 0.35,
        ease: 'power2.out',
        overwrite: true,
        onComplete: finish,
      });
    } else {
      gsap.killTweensOf(uniforms.uVideoMix);
      finish();
    }
  }

  /* ---------------- overlay open/close ----------------------------------- */
  function openOverlay(session) {
    clearTimeout(hideTimer);
    overlay.classList.remove('on', 'fo-out');
    void overlay.offsetWidth; // restart the corner-lock + scan animations
    overlay.classList.add('on');
    overlay.setAttribute('aria-hidden', 'false');

    const m = session.memory;
    /* title is aria ONLY — it never renders. No caption, ever. */
    frame.setAttribute('aria-label', (m.title ? m.title + ' — ' : '') + m.year);
    if (reduced) yearEl.textContent = String(m.year);
    else scrambleTo(yearEl, String(m.year));
    /* Years only — era names were retired from every visible surface. */
    const era = eraById.get(m.era);
    const yr = (era && era.yearRange) || [];
    eraEl.textContent = yr.length ? yr[0] + '–' + yr[1] : '';
    /* fake-but-honest archive coords: the card's own helix parameters */
    const h = helixAt(session.card.userData.t);
    const idx = cards.indexOf(session.card);
    metaEl.textContent =
      'MEM ' + pad2(idx + 1) + SEP + pad2(memoryCount) + '\n' +
      'θ ' + (((h.angle * 180) / Math.PI) % 360).toFixed(1) + '° · R ' +
      h.radius.toFixed(2) + ' · Y ' + h.y.toFixed(2);
    closeBtn.focus({ preventScroll: true });
  }

  function closeOverlay() {
    overlay.classList.add('fo-out'); // brackets fly back out
    overlay.setAttribute('aria-hidden', 'true');
    if (document.activeElement === closeBtn) closeBtn.blur();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      overlay.classList.remove('on', 'fo-out');
    }, reduced ? 0 : 340);
  }

  /* ---------------- open / close ----------------------------------------- */
  function open(card) {
    if (staged && staged.card === card) return;
    if (staged) beginClose(staged, true); // keep uFocus up across the swap

    /* if this very card is mid-flight home, take it over seamlessly */
    let startP = 0;
    for (const s of returning) {
      if (s.card === card) {
        gsap.killTweensOf(s.p);
        stopVideo(s, true);
        returning.delete(s);
        startP = s.p.v;
        break;
      }
    }

    const session = makeSession(card);
    session.p.v = startP;
    staged = session;
    computeStageSlot(session);

    /* the world stops: document scroll frozen, drag + idle-spin suspended */
    TIMELINE.source = 'focus';
    lockScroll();
    if (scroll && scroll.setSuspended) scroll.setSuspended(true);
    /* the DOM HUD steps back too — the staged card owns the frame */
    document.body.classList.add('focus-open');

    gsap.to(session.p, {
      v: 1,
      duration: reduced ? 0.15 : OPEN_S,
      ease: 'expo.out',
      overwrite: 'auto',
    });
    gsap.killTweensOf(uFocus);
    gsap.to(uFocus, { value: 1, duration: reduced ? 0.1 : 0.6, ease: 'power2.out' });

    startVideo(session);
    openOverlay(session);
  }

  function beginClose(session, keepFocusDim) {
    if (!session || session.closing) return;
    session.closing = true;

    if (staged === session) {
      staged = null;
      closeOverlay();
      if (!keepFocusDim) {
        gsap.killTweensOf(uFocus);
        gsap.to(uFocus, { value: 0, duration: reduced ? 0.1 : 0.5, ease: 'power2.out' });
      }
      /* hand time back immediately — home is group-LOCAL, so the card still
         lands on the helix even if the user scrolls while it flies back */
      TIMELINE.source = 'scroll';
      unlockScroll();
      if (scroll && scroll.setSuspended) scroll.setSuspended(false);
      document.body.classList.remove('focus-open');
    }

    stopVideo(session, false);
    returning.add(session);
    gsap.to(session.p, {
      v: 0,
      duration: reduced ? 0.15 : CLOSE_S,
      ease: 'power3.inOut',
      overwrite: 'auto',
      onComplete() {
        returning.delete(session);
        session.card.position.copy(session.homePos);   // exact home, no residue
        session.card.quaternion.copy(session.homeQuat);
      },
    });
  }

  /* ---------------- input ------------------------------------------------ */
  let downX = 0;
  let downY = 0;
  let downId = -1;

  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    downX = e.clientX;
    downY = e.clientY;
    downId = e.pointerId;
  });
  canvas.addEventListener('pointercancel', () => { downId = -1; });
  canvas.addEventListener('pointerup', (e) => {
    if (!e.isPrimary || e.pointerId !== downId) return;
    downId = -1;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (dx * dx + dy * dy > CLICK_SLOP * CLICK_SLOP) return; // a drag, not a click
    if (staged) {
      /* click outside the card region closes; the card itself is inert */
      if (!insideFrame(e.clientX, e.clientY)) beginClose(staged, false);
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    if (hit) open(hit);
  });

  closeBtn.addEventListener('click', () => {
    if (staged) beginClose(staged, false);
  });

  /* Enter opens the current (uLit max) card; ESC closes. Enter lands on the
     focused ✕ natively while open. (Roving tabindex arrives in U11.) */
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (staged) beginClose(staged, false);
      return;
    }
    if (e.key !== 'Enter' || staged) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== canvas &&
        /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    let best = null;
    let bestLit = -1;
    for (let i = 0; i < cards.length; i += 1) {
      const lit = cards[i].userData.uLit.value;
      if (lit > bestLit) { bestLit = lit; best = cards[i]; }
    }
    if (best) open(best);
  });

  /* re-fit the slot if the viewport changes under an open card */
  addEventListener('resize', () => {
    if (staged) computeStageSlot(staged);
  });

  function pick(cx, cy) {
    nPointer.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    raycaster.setFromCamera(nPointer, camera);
    const hits = raycaster.intersectObjects(cards, false);
    return hits.length ? hits[0].object : null;
  }

  /* ---------------- reticle projection ----------------------------------- */
  /* The overlay is DOM; the card is world. Each frame the staged card's
     four corners are projected to screen space and the frame box follows —
     parallax, the fov ease and the open tween all stay pixel-locked. */
  const rect = { x: 0, y: 0, w: 0, h: 0 };

  function insideFrame(cx, cy) {
    const slop = 8;
    return cx >= rect.x - slop && cx <= rect.x + rect.w + slop &&
           cy >= rect.y - slop && cy <= rect.y + rect.h + slop;
  }

  function projectFrame(session) {
    const geo = session.card.geometry.parameters;
    const hw = geo.width / 2;
    const hh = geo.height / 2;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i += 1) {
      vCorner
        .set(i & 1 ? hw : -hw, i & 2 ? hh : -hh, 0)
        .applyMatrix4(session.card.matrixWorld)
        .project(camera);
      const sx = (vCorner.x * 0.5 + 0.5) * innerWidth;
      const sy = (-vCorner.y * 0.5 + 0.5) * innerHeight;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (Math.abs(minX - rect.x) > 0.5 || Math.abs(minY - rect.y) > 0.5 ||
        Math.abs(w - rect.w) > 0.5 || Math.abs(h - rect.h) > 0.5) {
      rect.x = minX;
      rect.y = minY;
      rect.w = w;
      rect.h = h;
      frame.style.transform = 'translate3d(' + minX.toFixed(1) + 'px,' + minY.toFixed(1) + 'px,0)';
      frame.style.width = w.toFixed(1) + 'px';
      frame.style.height = h.toFixed(1) + 'px';
    }
  }

  /* ---------------- per-frame (called from app.js after applyLedger) ----- */
  function update() {
    if (!staged && returning.size === 0) return; // settled: one compare
    group.updateMatrixWorld();
    for (const s of returning) applySession(s);
    if (staged) {
      /* the conductor rewrites source as it settles — focus stays the truth */
      TIMELINE.source = 'focus';
      applySession(staged);
      staged.card.updateMatrixWorld();
      camera.updateMatrixWorld(); // refreshes matrixWorldInverse for project()
      projectFrame(staged);
    }
  }

  return {
    update,
    isOpen() {
      return staged !== null;
    },
    /* U10: the same open/close the pointer drives, reachable by script —
       js/cinema.js stages its focus beats through these and through
       nothing else, so a scripted beat and a real click are the same code
       path (and the same teardown) forever. */
    openCard(card) {
      if (card) open(card);
    },
    close() {
      if (staged) beginClose(staged, false);
    },
    staged() {
      return staged ? staged.card : null;
    },
  };
}
