# عُمر — OMR

A scroll-driven descent through a life, rendered in real time in the browser.
Photographs hang as glass lanterns on a helix falling away into the dark, a
thread of light runs down the axis, and the colour of the whole world shifts as
you pass through the years.

`عمر` means *a lifetime* — the span of it, not the number.

## The album is not in this repository

This is a family album, so **no photographs, no depth maps and no home video are
published here.** What ships is the engine and the pipeline that builds one.

`data/memories.json` is a **placeholder manifest** in the real schema, pointing
`src` at the abstract textures that do ship, so a clone runs immediately and the
whole system can be inspected end to end. It will look like drifting ink rather
than a childhood; everything else behaves exactly as it does with real input.

To use it for real, drop your own images into `photos/`, run the pipeline, and
rewrite the manifest — see [Building an album](#building-an-album).

## Running it

```bash
python tools/serve.py       # http://127.0.0.1:8000  (sends no-store)
```

No build step, no bundler, no `node_modules`. three.js arrives through a native
import map; every module in `js/` is loaded as-is.

| Flag | Effect |
|---|---|
| `?grid=1` | Force the static, no-WebGL grid |
| `?tier=base\|mid\|high` | Force a quality tier |
| `?intro=0` | Skip the nine-second opening |

## How it is built

| Path | What it is |
|---|---|
| `js/app.js` | The spine: one renderer, one scene, one rAF, and the `TIMELINE` state every other module reads |
| `js/boot.js` | Flags → WebGL2 gate → tier detection → `app.js` or `fallback.js` |
| `js/spiral.js` | The descending helix. `helixAt(t)` is the single source of truth for the curve |
| `js/thread.js` | The Thread of Light — a golden filament wound along the same helix, lit only from birth down to where you have reached |
| `js/core.js` | The pillar: a column of pure light on the axis, built from four additive phenomena and no solid surfaces at all |
| `js/mist.js` | Volumetric ink off the thread. A `GPUComputationRenderer` FBO pair advects up to 36,864 particles entirely on the GPU |
| `js/particles.js` | Fireflies, starfield and five merged nebula billboards. All motion computed in-shader from seeds — zero per-frame CPU particle work |
| `js/eras.js` | The colour ledger. Each era carries a tint and colour temperature, and everything born in a year keeps that year's colour |
| `js/focus.js` | Click a card and the helix holds its breath: it flies to a camera-locked stage slot behind an archive-scanner reticle |
| `js/intro.js` | Nine seconds, skippable at any frame, played over the live scene — not a video of the site, the site held in the dark until it is born |
| `js/cinema.js` | An auto-piloted ~62-second tour for screen capture |
| `js/quality.js` | Tier table, fail-safe boot detection, demote-only runtime governor |
| `js/fallback.js` | The static era-grouped grid for anything without WebGL2 |
| `tools/prepare_photos.py` | The album pipeline (see below) |

### Two decisions worth calling out

**Cinema is a second progress source, not a second camera.** It tweens one
virtual value into `TIMELINE` and the world moves through the exact same
pipeline the scroll drives. There is no parallel camera and no duplicated
easing, so polish on the interactive site lands in the recording for free and
the two can never drift apart — there is only one of them.

**The core is light, not geometry.** An earlier version was solid — dark glass,
machined collars — and solid geometry with visible shading reads as a CG render.
Replacing all of it with four additive, edgeless phenomena is what stopped it
looking rendered.

## Building an album

`tools/prepare_photos.py` turns a folder of originals into what the site loads.
It runs on [fal](https://fal.ai) and reads `FAL_KEY` from the environment — there
is no key in this repository and none is needed to read the code.

```bash
export FAL_KEY=...          # never commit this
python tools/prepare_photos.py --check     # dry run
python tools/prepare_photos.py
```

| Stage | Model | When |
|---|---|---|
| Restore | `fal-ai/image-editing/photo-restoration` | Old prints only |
| Upscale | `fal-ai/topaz/upscale/image` · `fal-ai/aura-sr` | Old prints · anything under 1600px |
| Depth | `fal-ai/image-preprocessors/depth-anything/v2` | Always, on the enhanced image |
| Animate | `fal-ai/minimax/hailuo-2.3-fast` · `fal-ai/kling-video/v3` | Opt-in, drafts and finals |

The depth map is what gives each card its parallax as the helix turns. Cards
without one fall back to a pseudo-depth derived in shader, so a manifest with
`"depth": null` is valid — as the placeholder album demonstrates.

## Credits

- **three.js** r170, from a CDN via a native import map
- **scroll-conductor**, vendored under `js/vendor/` with its licence
- **GSAP** for the intro and focus timelines
- Enhancement, depth and animation models run on **fal**

## Licence

MIT — see [LICENSE](LICENSE). The licence covers the code. The photographs it
was written for are not part of this repository and are not licensed here.
