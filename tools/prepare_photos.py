#!/usr/bin/env python
"""OMR photo preparation pipeline — raw life photos -> web-ready timeline assets.

Input   <root>/work/manifest.csv  +  <root>/work/<id>.<jpg|jpeg|png|webp>
Output  <root>/assets/{photos,depth,video}/  +  merged entries in <root>/data/memories.json

Stages per photo (a stage is skipped when its output file already exists):

  restore   old prints only                 fal-ai/image-editing/photo-restoration
  upscale   old prints -> topaz             fal-ai/topaz/upscale/image
            others, min side < 1600px       fal-ai/aura-sr
  depth     always, on the enhanced image   fal-ai/image-preprocessors/depth-anything/v2
  encode    local: WebP q82, max edge 2048px (photo + matching depth map)
  animate   heroes only, opt-in:
              --animate-drafts              fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video
              --animate-final               fal-ai/kling-video/v3/standard/image-to-video
  merge     upsert into data/memories.json, sorted by (year, id), atomic write

Usage:
  python omr/tools/prepare_photos.py --dry-run             # plan + cost, zero network
  python omr/tools/prepare_photos.py                       # run everything pending
  python omr/tools/prepare_photos.py --only im03,im07
  python omr/tools/prepare_photos.py --animate-final       # kling cinemagraphs for heroes
  python omr/tools/prepare_photos.py --check               # validate data <-> files, zero network

Exit codes: 0 ok · 1 some photos failed or --check found problems · 2 fal balance empty.
"""
import argparse
import base64
import csv
import io
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.request

QUEUE = "https://queue.fal.run"

MODEL_RESTORE = "fal-ai/image-editing/photo-restoration"
MODEL_TOPAZ = "fal-ai/topaz/upscale/image"
MODEL_AURA = "fal-ai/aura-sr"
MODEL_DEPTH = "fal-ai/image-preprocessors/depth-anything/v2"
MODEL_DRAFT = "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video"
MODEL_FINAL = "fal-ai/kling-video/v3/standard/image-to-video"

ANIMATE_PROMPT = "subtle cinemagraph, static camera, gentle idle motion, photorealistic"
ANIMATE_NEGATIVE = "camera pan, zoom, fast motion, morphing"

COST = {"restore": 0.04, "topaz": 0.08, "aura": 0.01, "depth": 0.01,
        "draft": 0.19, "final": 0.42}

UPSCALE_MIN = 1600          # non-prints are upscaled only below this min dimension
MAX_EDGE = 2048             # encoded webp longest edge
WEBP_QUALITY = 82
RAW_EXTS = (".jpg", ".jpeg", ".png", ".webp")
RETRY_DELAYS = (2, 6)       # seconds; 2 retries after the first attempt

BALANCE_MSG = ("fal balance is empty — top up at https://fal.ai/dashboard/billing "
               "(this is billing, not an auth problem)")

MANIFEST_COLS = ("id", "year", "era", "title", "caption", "old_print", "hero")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


# ---------------------------------------------------------------- plumbing --

class FalError(Exception):
    """A fal API call failed (retryable unless BalanceEmpty)."""
    def __init__(self, msg, status=None, body=""):
        super().__init__(msg)
        self.status = status
        self.body = body


class BalanceEmpty(FalError):
    """HTTP 403 whose body says the account balance is gone. Never retried."""


class Paths:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.work = os.path.join(self.root, "work")
        self.manifest = os.path.join(self.work, "manifest.csv")
        self.restored = os.path.join(self.work, "restored")
        self.upscaled = os.path.join(self.work, "upscaled")
        self.depth_work = os.path.join(self.work, "depth")
        self.drafts = os.path.join(self.work, "video_drafts")
        self.assets = os.path.join(self.root, "assets")
        self.photos_out = os.path.join(self.assets, "photos")
        self.depth_out = os.path.join(self.assets, "depth")
        self.video_out = os.path.join(self.assets, "video")
        self.data = os.path.join(self.root, "data")
        self.memories = os.path.join(self.data, "memories.json")


def log(msg):
    print(msg, file=sys.stderr)


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def get_key():
    key = os.environ.get("FAL_KEY")
    if key:
        return key.strip()
    path = os.path.join(os.path.expanduser("~"), ".fal", "credentials.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            key = json.load(f).get("fal_key")
        if key:
            return key.strip()
    die("no fal key (set FAL_KEY or ~/.fal/credentials.json)")


def req(url, key, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    r.add_header("Authorization", f"Key {key}")
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:2000]
        low = body.lower()
        if e.code == 403 and any(k in low for k in ("balance", "locked", "exhausted")):
            raise BalanceEmpty(f"HTTP 403 (balance) from {url}", 403, body)
        raise FalError(f"HTTP {e.code} from {url}: {body[:300]}", e.code, body)
    except urllib.error.URLError as e:
        raise FalError(f"network error contacting {url}: {e.reason}")


def run_model(model, payload, key, label, timeout=300):
    """Submit to the queue, poll to completion, return the result payload."""
    log(f"  -> {label} ({model})")
    sub = req(f"{QUEUE}/{model}", key, payload)
    status_url, response_url = sub.get("status_url"), sub.get("response_url")
    if not status_url:
        raise FalError(f"unexpected submit response: {json.dumps(sub)[:400]}")
    start, last = time.time(), None
    while True:
        st = req(status_url, key)
        state = st.get("status")
        if state != last:
            log(f"     {state}")
            last = state
        if state == "COMPLETED":
            break
        if state in ("FAILED", "ERROR"):
            raise FalError(f"{label} failed: {json.dumps(st)[:400]}")
        if time.time() - start > timeout:
            raise FalError(f"{label} timed out after {timeout}s "
                           f"(request {sub.get('request_id')})")
        time.sleep(2)
    return req(response_url, key)


def first_url(result):
    def walk(o):
        if isinstance(o, dict):
            u = o.get("url")
            if isinstance(u, str) and u.startswith("http"):
                yield u
            for v in o.values():
                yield from walk(v)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v)
    for u in walk(result):
        return u
    raise FalError(f"no media in result: {json.dumps(result)[:400]}")


def fetch(url):
    r = urllib.request.Request(url, headers={"User-Agent": "omr-prepare/1.0"})
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            return resp.read()
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        raise FalError(f"download failed from {url}: {e}")


def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "image/png"
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode()


def with_retry(label, fn):
    """Run fn; on FalError retry twice with backoff. BalanceEmpty aborts at once."""
    for attempt in range(len(RETRY_DELAYS) + 1):
        try:
            return fn()
        except BalanceEmpty:
            raise
        except FalError as e:
            if attempt < len(RETRY_DELAYS):
                delay = RETRY_DELAYS[attempt]
                log(f"     {label}: {e} — retrying in {delay}s "
                    f"({attempt + 1}/{len(RETRY_DELAYS)})")
                time.sleep(delay)
            else:
                raise


# ------------------------------------------------------------ image helpers --

def image_size(path):
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def save_image(blob, dest, fmt):
    """Decode a downloaded image and write it atomically as fmt (PNG here)."""
    from PIL import Image
    img = Image.open(io.BytesIO(blob))
    img.load()
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")
    ensure_dir(os.path.dirname(dest))
    tmp = dest + ".part"
    img.save(tmp, fmt)
    os.replace(tmp, dest)


def save_bytes(blob, dest):
    ensure_dir(os.path.dirname(dest))
    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        f.write(blob)
    os.replace(tmp, dest)


def encode_webp(src, dest, size=None, mode="RGB"):
    """Encode src as WebP q82. size=None clamps the longest edge to MAX_EDGE;
    an explicit size forces exact dimensions (used to pin depth to the photo)."""
    from PIL import Image
    with Image.open(src) as im:
        img = im.convert(mode)
    if size is not None:
        if img.size != size:
            img = img.resize(size, Image.Resampling.LANCZOS)
    elif max(img.size) > MAX_EDGE:
        scale = MAX_EDGE / max(img.size)
        img = img.resize((max(1, round(img.width * scale)),
                          max(1, round(img.height * scale))),
                         Image.Resampling.LANCZOS)
    ensure_dir(os.path.dirname(dest))
    tmp = dest + ".part"
    img.save(tmp, "WEBP", quality=WEBP_QUALITY, method=6)
    os.replace(tmp, dest)
    return img.size


# ---------------------------------------------------------------- manifest --

def parse_bool(v):
    return str(v).strip().lower() in ("true", "1", "yes", "y")


def find_raw(paths, pid):
    for ext in RAW_EXTS:
        p = os.path.join(paths.work, pid + ext)
        if os.path.exists(p):
            return p
    return None


def read_manifest(paths, required=True):
    if not os.path.exists(paths.manifest):
        if required:
            die(f"manifest not found: {paths.manifest}")
        return []
    rows, seen = [], set()
    with open(paths.manifest, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        missing = [c for c in MANIFEST_COLS if c not in (rd.fieldnames or [])]
        if missing:
            die(f"manifest.csv is missing columns: {', '.join(missing)}")
        for lineno, r in enumerate(rd, 2):
            pid = (r.get("id") or "").strip()
            if not pid:
                log(f"warning: manifest line {lineno} has an empty id — skipped")
                continue
            if not ID_RE.match(pid):
                die(f"manifest line {lineno}: id '{pid}' is not filesystem-safe")
            if pid in seen:
                die(f"manifest line {lineno}: duplicate id '{pid}'")
            seen.add(pid)
            try:
                year = int(str(r.get("year", "")).strip())
            except ValueError:
                die(f"manifest line {lineno} (id {pid}): year "
                    f"'{r.get('year')}' is not an integer")
            rows.append({
                "id": pid,
                "year": year,
                "era": (r.get("era") or "").strip(),
                "title": (r.get("title") or "").strip(),
                "caption": (r.get("caption") or "").strip(),
                "old_print": parse_bool(r.get("old_print")),
                "hero": parse_bool(r.get("hero")),
                "raw": find_raw(paths, pid),
            })
    return rows


# ------------------------------------------------------------ memories.json --

def load_memories(paths, create=False):
    if not os.path.exists(paths.memories):
        log(f"warning: {paths.memories} not found — using empty "
            '{"eras": [], "memories": []}')
        data = {"eras": [], "memories": []}
        if create:
            atomic_write_json(paths.memories, data)
        return data
    with open(paths.memories, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("eras", [])
    data.setdefault("memories", [])
    return data


def atomic_write_json(path, data):
    ensure_dir(os.path.dirname(path))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def merge_records(paths, records):
    """Upsert successful photo records, keyed by id, sorted by (year, id)."""
    data = load_memories(paths)
    by_id = {m.get("id"): m for m in data["memories"] if isinstance(m, dict)}
    for rec in records:
        old = by_id.get(rec["id"])
        if old and rec["video"] is None and old.get("video"):
            rec["video"] = old["video"]      # never clobber a recorded video
        by_id[rec["id"]] = rec
    data["memories"] = sorted(by_id.values(),
                              key=lambda m: (m.get("year", 0), str(m.get("id", ""))))
    atomic_write_json(paths.memories, data)


# ----------------------------------------------------------------- planning --

def upscale_decision(photo, paths):
    """-> (kind, reason). kind: 'topaz' | 'aura' | None."""
    if photo["old_print"]:
        return "topaz", "old print"
    if not photo["raw"]:
        return None, "no source image"
    w, h = image_size(photo["raw"])
    if min(w, h) < UPSCALE_MIN:
        return "aura", f"min dimension {min(w, h)}px < {UPSCALE_MIN}"
    return None, f"min dimension {min(w, h)}px >= {UPSCALE_MIN}"


def plan_photo(photo, paths, args):
    """List of (stage, action, detail, cost) — mirrors exactly what run does."""
    pid = photo["id"]
    steps = []
    if not photo["raw"]:
        steps.append(("source", "FAIL",
                      f"no work/{pid}.<jpg|jpeg|png|webp> found", 0.0))
        return steps

    restored = os.path.join(paths.restored, pid + ".png")
    if not photo["old_print"]:
        steps.append(("restore", "skip", "not an old print", 0.0))
    elif os.path.exists(restored):
        steps.append(("restore", "skip", f"work/restored/{pid}.png exists", 0.0))
    else:
        steps.append(("restore", "RUN", MODEL_RESTORE, COST["restore"]))

    upscaled = os.path.join(paths.upscaled, pid + ".png")
    if os.path.exists(upscaled):
        steps.append(("upscale", "skip", f"work/upscaled/{pid}.png exists", 0.0))
    else:
        kind, reason = upscale_decision(photo, paths)
        if kind == "topaz":
            steps.append(("upscale", "RUN", f"{MODEL_TOPAZ} ({reason})", COST["topaz"]))
        elif kind == "aura":
            steps.append(("upscale", "RUN", f"{MODEL_AURA} ({reason})", COST["aura"]))
        else:
            steps.append(("upscale", "skip", reason, 0.0))

    depth_png = os.path.join(paths.depth_work, pid + ".png")
    if os.path.exists(depth_png):
        steps.append(("depth", "skip", f"work/depth/{pid}.png exists", 0.0))
    else:
        steps.append(("depth", "RUN", MODEL_DEPTH, COST["depth"]))

    photo_webp = os.path.join(paths.photos_out, pid + ".webp")
    depth_webp = os.path.join(paths.depth_out, pid + ".webp")
    if os.path.exists(photo_webp) and os.path.exists(depth_webp):
        steps.append(("encode", "skip", "both assets exist", 0.0))
    else:
        steps.append(("encode", "RUN",
                      f"local WebP q{WEBP_QUALITY} max-edge {MAX_EDGE} -> "
                      f"assets/photos/{pid}.webp + assets/depth/{pid}.webp", 0.0))

    if not photo["hero"]:
        steps.append(("animate", "skip", "not a hero photo", 0.0))
    else:
        draft = os.path.join(paths.drafts, pid + ".mp4")
        final = os.path.join(paths.video_out, pid + ".mp4")
        if not args.animate_drafts:
            steps.append(("draft", "skip", "--animate-drafts not given", 0.0))
        elif os.path.exists(draft):
            steps.append(("draft", "skip", f"work/video_drafts/{pid}.mp4 exists", 0.0))
        else:
            steps.append(("draft", "RUN", MODEL_DRAFT, COST["draft"]))
        if not args.animate_final:
            steps.append(("final", "skip", "--animate-final not given", 0.0))
        elif os.path.exists(final):
            steps.append(("final", "skip", f"assets/video/{pid}.mp4 exists", 0.0))
        else:
            steps.append(("final", "RUN", MODEL_FINAL, COST["final"]))
    return steps


def run_dry(rows, paths, args):
    print(f"DRY RUN — plan for {len(rows)} photo(s) under {paths.root}")
    print("No network calls are made in this mode.\n")
    total = 0.0
    for photo in rows:
        flags = (f"{photo['year']}  era={photo['era'] or '?'}  "
                 f"old_print={'yes' if photo['old_print'] else 'no'}  "
                 f"hero={'yes' if photo['hero'] else 'no'}")
        print(f"{photo['id']}  {flags}")
        subtotal = 0.0
        for stage, action, detail, cost in plan_photo(photo, paths, args):
            tail = f"  ${cost:.2f}" if cost else ""
            print(f"  {stage:<8} {action:<5} {detail}{tail}")
            subtotal += cost
        print(f"  subtotal ${subtotal:.2f}\n")
        total += subtotal
    print(f"Estimated total: ${total:.2f}")


# ---------------------------------------------------------------- execution --

def process_photo(photo, paths, args, key):
    """Run all stages for one photo; return its memories.json record."""
    pid = photo["id"]
    log(f"\n=== {pid} ({photo['year']}, {photo['era']}) ===")
    if not photo["raw"]:
        raise FalError(f"no source image work/{pid}.<jpg|jpeg|png|webp>")
    src = photo["raw"]

    # 1. restore (old prints only)
    restored = os.path.join(paths.restored, pid + ".png")
    if photo["old_print"]:
        if os.path.exists(restored):
            log(f"  restore: skip (exists {restored})")
        else:
            def do_restore():
                result = run_model(MODEL_RESTORE, {"image_url": data_uri(src)},
                                   key, f"{pid} restore")
                save_image(fetch(first_url(result)), restored, "PNG")
            with_retry(f"{pid} restore", do_restore)
            log(f"     saved {restored}")
        src = restored

    # 2. upscale
    upscaled = os.path.join(paths.upscaled, pid + ".png")
    if os.path.exists(upscaled):
        log(f"  upscale: skip (exists {upscaled})")
        src = upscaled
    else:
        kind, reason = upscale_decision(photo, paths)
        if kind is None:
            log(f"  upscale: skip ({reason})")
        else:
            model = MODEL_TOPAZ if kind == "topaz" else MODEL_AURA
            extra = ({"model": "Standard V2", "upscale_factor": 4,
                      "output_format": "png"} if kind == "topaz" else {})
            up_src = src

            def do_upscale():
                payload = dict(extra, image_url=data_uri(up_src))
                result = run_model(model, payload, key,
                                   f"{pid} upscale ({kind})", timeout=600)
                save_image(fetch(first_url(result)), upscaled, "PNG")
            with_retry(f"{pid} upscale", do_upscale)
            log(f"     saved {upscaled}")
            src = upscaled

    # 3. depth — always, on the final enhanced image
    depth_png = os.path.join(paths.depth_work, pid + ".png")
    if os.path.exists(depth_png):
        log(f"  depth: skip (exists {depth_png})")
    else:
        # Depth-anything gains nothing above ~2k, and a 4x-upscaled source as
        # a data URI blows past fal's request-size limit (nginx 502). Feed it
        # a capped copy; the displacement map aligns with the encoded webp
        # (same aspect), not the upscale.
        depth_src = src
        from PIL import Image
        with Image.open(src) as probe:
            if max(probe.size) > 2048:
                capped = os.path.join(paths.depth_work, pid + "-in.jpg")
                ensure_dir(paths.depth_work)
                small = probe.convert("RGB")
                small.thumbnail((2048, 2048), Image.LANCZOS)
                small.save(capped, "JPEG", quality=92)
                depth_src = capped

        def do_depth():
            result = run_model(MODEL_DEPTH, {"image_url": data_uri(depth_src)},
                               key, f"{pid} depth")
            save_image(fetch(first_url(result)), depth_png, "PNG")
        with_retry(f"{pid} depth", do_depth)
        if depth_src != src:
            os.remove(depth_src)
        log(f"     saved {depth_png}")

    # 4. encode — local, no network
    photo_webp = os.path.join(paths.photos_out, pid + ".webp")
    depth_webp = os.path.join(paths.depth_out, pid + ".webp")
    if os.path.exists(photo_webp):
        w, h = image_size(photo_webp)
        log(f"  encode: skip photo (exists {photo_webp}, {w}x{h})")
    else:
        w, h = encode_webp(src, photo_webp)
        log(f"  encode: saved {photo_webp} ({w}x{h})")
    if os.path.exists(depth_webp):
        log(f"  encode: skip depth (exists {depth_webp})")
    else:
        encode_webp(depth_png, depth_webp, size=(w, h), mode="L")
        log(f"  encode: saved {depth_webp} ({w}x{h})")

    # 5. living photos — heroes only, opt-in
    final_mp4 = os.path.join(paths.video_out, pid + ".mp4")
    if photo["hero"]:
        if args.animate_drafts:
            draft_mp4 = os.path.join(paths.drafts, pid + ".mp4")
            if os.path.exists(draft_mp4):
                log(f"  draft: skip (exists {draft_mp4})")
            else:
                def do_draft():
                    result = run_model(
                        MODEL_DRAFT,
                        {"prompt": ANIMATE_PROMPT, "image_url": data_uri(photo_webp)},
                        key, f"{pid} draft video", timeout=900)
                    save_bytes(fetch(first_url(result)), draft_mp4)
                with_retry(f"{pid} draft", do_draft)
                log(f"     saved {draft_mp4}")
        if args.animate_final:
            if os.path.exists(final_mp4):
                log(f"  final: skip (exists {final_mp4})")
            else:
                def do_final():
                    result = run_model(
                        MODEL_FINAL,
                        {"prompt": ANIMATE_PROMPT,
                         "image_url": data_uri(photo_webp),
                         "negative_prompt": ANIMATE_NEGATIVE},
                        key, f"{pid} final video", timeout=900)
                    save_bytes(fetch(first_url(result)), final_mp4)
                with_retry(f"{pid} final", do_final)
                log(f"     saved {final_mp4}")

    return {
        "id": pid,
        "year": photo["year"],
        "era": photo["era"],
        "title": photo["title"],
        "caption": photo["caption"],
        "src": f"assets/photos/{pid}.webp",
        "depth": f"assets/depth/{pid}.webp",
        "video": f"assets/video/{pid}.mp4" if os.path.exists(final_mp4) else None,
        "w": w,
        "h": h,
        "hero": photo["hero"],
    }


def run_pipeline(rows, paths, args):
    key = get_key()
    for d in (paths.restored, paths.upscaled, paths.depth_work, paths.drafts,
              paths.photos_out, paths.depth_out, paths.video_out, paths.data):
        ensure_dir(d)
    load_memories(paths, create=True)   # creates the skeleton (with warning) if absent

    records, failures = [], []
    for photo in rows:
        try:
            records.append(process_photo(photo, paths, args, key))
        except BalanceEmpty:
            log(BALANCE_MSG)
            sys.exit(2)                 # no manifest write at all
        except FalError as e:
            log(f"  FAILED {photo['id']}: {e}")
            failures.append((photo["id"], str(e)))
        except OSError as e:
            log(f"  FAILED {photo['id']}: {e}")
            failures.append((photo["id"], str(e)))

    if records:
        merge_records(paths, records)
        log(f"\nmerged {len(records)} record(s) into {paths.memories}")
    else:
        log(f"\nno successful photos — {paths.memories} left untouched")

    if failures:
        log(f"\n{len(failures)} photo(s) failed:")
        for pid, why in failures:
            log(f"  {pid}: {why}")
        sys.exit(1)


# ------------------------------------------------------------------- check --

def resolve(paths, rel):
    return os.path.normpath(os.path.join(paths.root, rel))


def run_check(paths, rows):
    errors, warnings = [], []
    data = load_memories(paths)         # missing file -> warned, treated as empty
    if not os.path.exists(paths.memories):
        warnings.append("data/memories.json is missing (validated as empty)")

    eras = {}
    for e in data["eras"]:
        eid = e.get("id")
        if not eid:
            errors.append(f"era without id: {json.dumps(e)[:120]}")
        else:
            eras[eid] = e

    referenced, seen = set(), set()
    for m in data["memories"]:
        mid = m.get("id")
        if not mid:
            errors.append(f"memory without id: {json.dumps(m)[:120]}")
            continue
        if mid in seen:
            errors.append(f"{mid}: duplicate memory id")
        seen.add(mid)

        w, h = m.get("w"), m.get("h")
        if not isinstance(w, int) or not isinstance(h, int):
            errors.append(f"{mid}: w/h must be integers (got {w!r}, {h!r})")
            w = h = None
        for field in ("src", "depth"):
            rel = m.get(field)
            if not rel:
                errors.append(f"{mid}: missing '{field}'")
                continue
            p = resolve(paths, rel)
            referenced.add(os.path.normcase(p))
            if not os.path.exists(p):
                errors.append(f"{mid}: {field} file not found: {rel}")
            elif w is not None:
                try:
                    aw, ah = image_size(p)
                except OSError as e:
                    errors.append(f"{mid}: cannot read {rel}: {e}")
                    continue
                if (aw, ah) != (w, h):
                    errors.append(f"{mid}: {field} is {aw}x{ah} but entry "
                                  f"says {w}x{h} ({rel})")
        video = m.get("video")
        if video:
            p = resolve(paths, video)
            referenced.add(os.path.normcase(p))
            if not os.path.exists(p):
                errors.append(f"{mid}: video file not found: {video}")

        era_id = m.get("era")
        era = eras.get(era_id)
        if era is None:
            errors.append(f"{mid}: era '{era_id}' not defined in eras")
        else:
            yr = era.get("yearRange")
            year = m.get("year")
            if (not isinstance(yr, list) or len(yr) != 2
                    or not all(isinstance(y, int) for y in yr)):
                errors.append(f"era '{era_id}': malformed yearRange {yr!r}")
            elif not isinstance(year, int):
                errors.append(f"{mid}: year {year!r} is not an integer")
            elif not (yr[0] <= year <= yr[1]):
                errors.append(f"{mid}: year {year} outside era '{era_id}' "
                              f"range {yr[0]}-{yr[1]}")

    for d in (paths.photos_out, paths.depth_out, paths.video_out):
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if os.path.isfile(p) and os.path.normcase(os.path.normpath(p)) not in referenced:
                warnings.append(f"orphan asset not referenced by any memory: "
                                f"{os.path.relpath(p, paths.root)}")

    for photo in rows:
        if photo["id"] not in seen:
            warnings.append(f"manifest id '{photo['id']}' has no memories.json "
                            f"entry yet (pipeline not run?)")

    print(f"CHECK {paths.root}")
    for e in errors:
        print(f"  ERROR {e}")
    for wmsg in warnings:
        print(f"  warn  {wmsg}")
    print(f"check: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


# -------------------------------------------------------------------- main --

def main():
    p = argparse.ArgumentParser(
        description="Prepare OMR life photos: restore, upscale, depth, encode, "
                    "animate, and merge into data/memories.json")
    p.add_argument("--check", action="store_true",
                   help="validate memories.json <-> files <-> dimensions (no network)")
    p.add_argument("--dry-run", action="store_true",
                   help="print the per-photo plan and cost estimate (no network)")
    p.add_argument("--animate-drafts", action="store_true",
                   help="hailuo draft videos for hero photos -> work/video_drafts/")
    p.add_argument("--animate-final", action="store_true",
                   help="kling final cinemagraphs for hero photos -> assets/video/")
    p.add_argument("--only", help="comma-separated photo ids to process")
    p.add_argument("--root",
                   default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   help="project root containing work/, assets/, data/ "
                        "(default: the omr/ folder above this script)")
    args = p.parse_args()

    paths = Paths(args.root)
    rows = read_manifest(paths, required=not args.check)

    if args.only:
        want = [s.strip() for s in args.only.split(",") if s.strip()]
        have = {r["id"] for r in rows}
        unknown = [s for s in want if s not in have]
        if unknown:
            die(f"--only ids not in manifest: {', '.join(unknown)}")
        rows = [r for r in rows if r["id"] in want]

    if args.check:
        sys.exit(run_check(paths, rows))
    if not rows:
        die("no photos to process (empty manifest?)")
    if args.dry_run:
        run_dry(rows, paths, args)
        return
    run_pipeline(rows, paths, args)


if __name__ == "__main__":
    main()
