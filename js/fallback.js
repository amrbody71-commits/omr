/* fallback.js — U7: the static-grid floor. The page the site becomes when
   WebGL2 is absent (TIER floor) or when asked for outright (?grid=1) —
   and the honest crawler/SEO view of the same content.

   Real content, no apologies: data/memories.json rendered as era-grouped
   sections — era label in Fraunces with its yearRange in mono, every
   memory a card. Photos may not exist yet (404 is the normal path, same
   as js/textures.js), so each card carries its era-tinted placeholder
   gradient — the SAME tint math as the WebGL placeholders — and a quiet
   HEAD probe swaps in the real photo only when the file is actually
   there. No WebGL, no three.js, no gsap: this file must work when
   everything else cannot. */

const VOID = [16, 18, 38];     // #101226 — matches js/textures.js

/* ---- the placeholder tint math, verbatim from js/textures.js --------- */
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
function css(c) {
  return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
}

/* era tint → the card's vertical gradient (top/bottom stops exactly as the
   WebGL placeholder paints them: desaturated-darkened tint → near-void). */
function gradientFor(tintHex) {
  const tint = hexToRgb(tintHex || '#F4EFE6');
  const top = mixRgb(mixRgb(tint, grayOf(tint), 0.45), VOID, 0.55);
  const bottom = mixRgb(tint, VOID, 0.9);
  return 'linear-gradient(180deg, ' + css(top) + ' 0%, ' + css(bottom) + ' 100%)';
}

/* ------------------------------------------------------------------ */

const STYLE = `
#grid-fallback{position:relative;z-index:5;max-width:1120px;margin:0 auto;
  padding:11vh 6vw 15vh;}
.gf-kicker{font-family:'Spline Sans Mono',monospace;font-size:11px;
  letter-spacing:.24em;color:var(--thread);}
.gf-head h1{font-family:'Fraunces',serif;font-weight:400;
  font-size:clamp(38px,6vw,64px);line-height:1.08;color:var(--ink);
  margin-top:14px;}
.gf-intro{margin-top:18px;max-width:36em;font-size:15px;line-height:1.85;
  color:rgba(244,239,230,.62);}
.gf-era{margin-top:96px;}
.gf-era-head{display:flex;align-items:baseline;justify-content:space-between;
  gap:18px;border-bottom:1px solid rgba(244,239,230,.14);padding-bottom:14px;}
.gf-era-label{font-family:'Fraunces',serif;font-weight:400;
  font-size:clamp(24px,3.4vw,36px);letter-spacing:.03em;color:var(--ink);}
.gf-era-years{font-family:'Spline Sans Mono',monospace;font-size:11px;
  letter-spacing:.18em;color:var(--thread);white-space:nowrap;}
.gf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));
  gap:40px 28px;margin-top:36px;}
.gf-frame{position:relative;aspect-ratio:16/21;overflow:hidden;
  border-radius:4px;border:1px solid rgba(244,239,230,.14);
  box-shadow:0 18px 40px rgba(0,0,0,.35);}
.gf-frame::after{content:'';position:absolute;inset:7px;
  border:1px solid rgba(244,239,230,.08);border-radius:2px;pointer-events:none;}
.gf-etch{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;font-family:'Spline Sans Mono',monospace;
  font-weight:500;font-size:clamp(46px,5.6vw,74px);letter-spacing:.04em;
  color:rgba(244,239,230,.09);}
.gf-frame img{position:absolute;inset:0;width:100%;height:100%;
  object-fit:cover;display:block;}
.gf-meta{margin-top:14px;display:flex;align-items:baseline;gap:12px;
  font-family:'Spline Sans Mono',monospace;}
.gf-year{font-size:11px;letter-spacing:.14em;color:var(--thread);}
.gf-title{font-weight:400;font-size:12px;letter-spacing:.14em;
  font-variant-caps:small-caps;text-transform:lowercase;color:var(--ink);}
.gf-foot{margin-top:110px;border-top:1px solid rgba(244,239,230,.12);
  padding-top:22px;display:flex;justify-content:space-between;gap:14px;
  flex-wrap:wrap;font-family:'Spline Sans Mono',monospace;font-size:10px;
  letter-spacing:.16em;color:rgba(244,239,230,.4);}
.gf-err{margin-top:60px;font-family:'Spline Sans Mono',monospace;
  font-size:12px;letter-spacing:.08em;line-height:1.7;color:var(--accent);}
@media (max-width:760px){
  .gf-era{margin-top:72px;}
  .gf-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
    gap:30px 16px;}
}
`;

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

/* The WebGL chrome has no business on the floor page — hide it and drop
   the 1080vh scroll track so the document is its own honest length. */
function retireSceneChrome() {
  ['scene', 'wordmark', 'era-index', 'year-hud', 'cinema-btn'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.style.display = 'none';
  });
  const main = document.querySelector('main');
  if (main) main.remove();
}

/* One quiet HEAD per photo — exactly the js/textures.js contract: 404 is
   normal, silence is the answer either way. */
async function probe(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch (err) {
    return false;
  }
}

/* Manifest-shape agnostic: the photo pipeline is rewriting the manifest as
   real files land, so trust an explicit src when present and otherwise
   derive the canonical assets/photos/<id>.webp path from the id. */
function photoUrl(memory) {
  if (memory.src) return memory.src;
  return memory.id ? 'assets/photos/' + memory.id + '.webp' : '';
}

function attachPhoto(frame, memory) {
  const url = photoUrl(memory);
  if (!url) return;
  probe(url).then((ok) => {
    if (!ok) return;                       // gradient stays — by design
    const img = document.createElement('img');
    img.src = url;
    img.alt = memory.title || String(memory.year || 'memory');
    img.loading = 'lazy';
    if (memory.w && memory.h) { img.width = memory.w; img.height = memory.h; }
    frame.appendChild(img);                // covers the etched year
  });
}

function build(root, data) {
  const eras = data.eras || [];
  const memories = data.memories || [];

  const head = el('header', 'gf-head', root);
  el('p', 'gf-kicker', head, 'A LIFE IN LIGHT');
  const h1 = el('h1', null, head, 'عُمر — OMR');
  h1.dir = 'auto';
  el('p', 'gf-intro', head,
    'Fourteen memories on a descending spiral — held still. '
    + 'The living version renders this page as a helix of glass and '
    + 'lamplight; what follows is the same life, laid out plainly.');

  eras.forEach((era) => {
    const rows = memories.filter((m) => m.era === era.id);
    if (!rows.length) return;

    const section = el('section', 'gf-era', root);
    const eraHead = el('div', 'gf-era-head', section);
    el('h2', 'gf-era-label', eraHead, era.label || era.id);
    const years = Array.isArray(era.yearRange)
      ? era.yearRange[0] + '–' + era.yearRange[1] : '';
    el('span', 'gf-era-years', eraHead, years);

    const grid = el('div', 'gf-grid', section);
    rows.forEach((memory) => {
      const card = el('article', 'gf-card', grid);
      const frame = el('div', 'gf-frame', card);
      frame.style.background = gradientFor(era.tint);
      el('span', 'gf-etch', frame, String(memory.year || '····'));
      attachPhoto(frame, memory);

      const meta = el('div', 'gf-meta', card);
      el('span', 'gf-year', meta, String(memory.year || ''));
      el('h3', 'gf-title', meta, memory.title || '');
      /* No captions — removed from the collection by design. */
    });
  });

  const foot = el('footer', 'gf-foot', root);
  el('span', null, foot, 'عُمر — OMR');
  const first = eras[0] && eras[0].yearRange;
  const last = eras[eras.length - 1] && eras[eras.length - 1].yearRange;
  if (first && last) {
    el('span', null, foot, first[0] + ' – ' + last[1]);
  }
}

/* Boot entry (js/boot.js): renders the floor page, then signals readiness
   exactly like the app does — the loader retires on `omr:ready`. */
export async function start() {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  retireSceneChrome();

  const root = el('div', null, document.body);
  root.id = 'grid-fallback';

  try {
    const res = await fetch('data/memories.json');
    if (!res.ok) throw new Error('memories.json failed to load (' + res.status + ')');
    build(root, await res.json());
  } catch (err) {
    /* Even the floor has a floor: name the failure, stay composed. */
    const head = el('header', 'gf-head', root);
    el('p', 'gf-kicker', head, 'A LIFE IN LIGHT');
    const h1 = el('h1', null, head, 'عُمر — OMR');
    h1.dir = 'auto';
    el('p', 'gf-err', root,
      'The archive did not load. ' + String((err && err.message) || err).slice(0, 200));
  }

  dispatchEvent(new CustomEvent('omr:ready'));
}
