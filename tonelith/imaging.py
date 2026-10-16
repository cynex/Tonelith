"""Decoding, the develop pipeline, preview/thumbnail caching and export encoding.

Originals are never modified. Decoded working copies ("proxies"), thumbnails and
other processing artefacts live in data/temp.
"""
import collections
import hashlib
import json
import os
import shutil
import threading

import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    import rawpy
except ImportError:  # RAW support degrades gracefully
    rawpy = None
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pillow_heif = None

from . import settings as S
from .db import DATA_DIR

Image.MAX_IMAGE_PIXELS = None
cv2.setNumThreads(max(1, (os.cpu_count() or 2)))

TEMP_DIR = os.path.join(DATA_DIR, "temp")
PROXY_DIR = os.path.join(TEMP_DIR, "proxy")
THUMB_DIR = os.path.join(TEMP_DIR, "thumbs")
for _d in (PROXY_DIR, THUMB_DIR):
    os.makedirs(_d, exist_ok=True)

PROXY_LONG = 1800
THUMB_LONG = 360

RAW_EXT = {
    ".3fr", ".ari", ".arw", ".bay", ".braw", ".cap", ".cr2", ".cr3", ".crw", ".dcr", ".dcs",
    ".dng", ".drf", ".eip", ".erf", ".fff", ".gpr", ".iiq", ".k25", ".kdc", ".mdc", ".mef",
    ".mos", ".mrw", ".nef", ".nrw", ".obm", ".orf", ".pef", ".ptx", ".pxn", ".r3d", ".raf",
    ".raw", ".rw2", ".rwl", ".rwz", ".sr2", ".srf", ".srw", ".x3f",
}
STD_EXT = {".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".tif", ".tiff", ".bmp", ".dib", ".webp",
           ".gif", ".heic", ".heif", ".avif", ".jp2"}
SUPPORTED_EXT = RAW_EXT | STD_EXT


def ext_of(path):
    return os.path.splitext(path)[1].lower()


def is_supported(path):
    return ext_of(path) in SUPPORTED_EXT


# --------------------------------------------------------------------------
# Decoding -> uint16 RGB (H, W, 3), sRGB-encoded
# --------------------------------------------------------------------------

def _to_u16(arr):
    if arr.dtype == np.uint16:
        return arr
    if arr.dtype == np.uint8:
        return arr.astype(np.uint16) * 257
    return (np.clip(arr, 0, 1) * 65535 + 0.5).astype(np.uint16)


def _decode_raw(path, want_long=None):
    """Returns (rgb16, half) where half says the demosaic ran at half resolution."""
    if rawpy is None:
        raise RuntimeError("rawpy is not installed; RAW files are unsupported")
    with rawpy.imread(path) as raw:
        long_side = max(raw.sizes.width, raw.sizes.height)
        half = bool(want_long) and long_side >= 2 * want_long
        try:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=16, half_size=half,
                                  output_color=rawpy.ColorSpace.sRGB, gamma=(2.4, 12.92))
            return rgb, half
        except Exception:
            # Unusual files: fall back to the embedded preview image.
            thumb = raw.extract_thumb()
            if thumb.format == rawpy.ThumbFormat.JPEG:
                data = np.frombuffer(thumb.data, np.uint8)
                bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
                if bgr is not None:
                    return np.ascontiguousarray(_to_u16(bgr)[..., ::-1]), False
            elif thumb.format == rawpy.ThumbFormat.BITMAP:
                return _to_u16(thumb.data), False
            raise


def _decode_std(path):
    ext = ext_of(path)
    if ext in (".png", ".tif", ".tiff"):  # keeps 16-bit data
        data = np.fromfile(path, np.uint8)
        im = cv2.imdecode(data, cv2.IMREAD_COLOR | cv2.IMREAD_ANYDEPTH)  # BGR (IMREAD_COLOR_RGB is broken for TIFF in cv2 5.0)
        if im is not None:
            return np.ascontiguousarray(_to_u16(im)[..., ::-1])
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("I;16", "I;16L", "I;16B", "I"):
            g = np.clip(np.asarray(im), 0, 65535).astype(np.uint16)
            return np.dstack([g, g, g])
        return _to_u16(np.asarray(im.convert("RGB")))


def decode(path, want_long=None):
    """Decode to uint16 RGB. Returns (array, full_w, full_h)."""
    if ext_of(path) in RAW_EXT:
        rgb, half = _decode_raw(path, want_long)
        h, w = rgb.shape[:2]
        return rgb, (w * 2 if half else w), (h * 2 if half else h)
    rgb = _decode_std(path)
    h, w = rgb.shape[:2]
    return rgb, w, h


def probe(path):
    """True if the file can be opened by Pillow (for files with unknown extensions)."""
    try:
        with Image.open(path) as im:
            im.verify()
        return True
    except Exception:
        return False


def resize_long(arr, long_edge):
    h, w = arr.shape[:2]
    if max(h, w) <= long_edge:
        return arr
    k = long_edge / max(h, w)
    return cv2.resize(arr, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)


# --------------------------------------------------------------------------
# Proxy cache (decoded working copy at reduced size, stored in data/temp)
# --------------------------------------------------------------------------

_mem = collections.OrderedDict()
_mem_lock = threading.Lock()
_key_locks = collections.defaultdict(threading.Lock)


def file_key(path):
    st = os.stat(path)
    raw = f"{os.path.abspath(path)}|{st.st_mtime_ns}|{st.st_size}"
    return hashlib.sha1(raw.encode("utf-8", "surrogatepass")).hexdigest()[:20]


def purge_path(path):
    """Delete the cached proxy and thumbnails of a file (never the file itself)."""
    try:
        key = file_key(path)
    except OSError:
        return  # file is gone; its cache entries can't be matched by key and are cleared with the temp data
    with _mem_lock:
        _mem.pop(key, None)
    for d in (PROXY_DIR, THUMB_DIR):
        for name in os.listdir(d):
            if name.startswith(key + "_") or name.startswith(key + ".") or name.startswith(f"fs_{key}."):
                try:
                    os.remove(os.path.join(d, name))
                except OSError:
                    pass


def get_proxy(path):
    """Returns (rgb16 proxy, full_w, full_h, key)."""
    key = file_key(path)
    with _mem_lock:
        if key in _mem:
            _mem.move_to_end(key)
            return (*_mem[key], key)
    with _key_locks[key]:
        with _mem_lock:
            if key in _mem:
                return (*_mem[key], key)
        npy = os.path.join(PROXY_DIR, key + ".npy")
        meta = os.path.join(PROXY_DIR, key + ".json")
        try:
            arr = np.load(npy)
            with open(meta) as f:
                m = json.load(f)
            entry = (arr, m["w"], m["h"])
        except Exception:
            arr, fw, fh = decode(path, PROXY_LONG)
            arr = np.ascontiguousarray(resize_long(arr, PROXY_LONG))
            np.save(npy, arr)
            with open(meta, "w") as f:
                json.dump({"w": fw, "h": fh, "src": path}, f)
            entry = (arr, fw, fh)
        with _mem_lock:
            _mem[key] = entry
            while len(_mem) > 8:
                _mem.popitem(last=False)
    return (*entry, key)


def cache_stats():
    total = count = 0
    for d in (PROXY_DIR, THUMB_DIR):
        for f in os.listdir(d):
            try:
                total += os.path.getsize(os.path.join(d, f))
                count += 1
            except OSError:
                pass
    return {"files": count, "bytes": total, "path": TEMP_DIR}


def clear_cache():
    with _mem_lock:
        _mem.clear()
        _full.clear()
    for d in (PROXY_DIR, THUMB_DIR):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)


# --------------------------------------------------------------------------
# Develop pipeline
# --------------------------------------------------------------------------

_LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
_GAMMA = 2.2


def _luma(x):
    return x @ _LUMA


def _hue_vec(deg):
    """Zero-mean RGB direction for a hue angle."""
    rgb = np.array(cv2.cvtColor(np.array([[[deg, 1.0, 1.0]]], np.float32), cv2.COLOR_HSV2RGB)[0, 0], np.float32)
    return rgb - rgb.mean()


def _denoise(x, s, scale):
    nl, nc = s["nr_luma"], s["nr_color"]
    ycc = cv2.cvtColor(x, cv2.COLOR_RGB2YCrCb)
    y = ycc[..., 0]
    if nl > 0:
        y8 = np.clip(y * 255 + 0.5, 0, 255).astype(np.uint8)
        den = cv2.fastNlMeansDenoising(y8, None, nl / 100 * 14, 5, 15)
        y = y + (den.astype(np.float32) - y8) / 255
    cr, cb = ycc[..., 1], ycc[..., 2]
    if nc > 0:
        h, w = y.shape
        sp = max(1.0, nc / 100 * 8 * scale)
        sc = 0.03 + nc / 100 * 0.08
        out = []
        for c in (cr, cb):
            small = cv2.resize(c, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
            small = cv2.bilateralFilter(small, 9, sc, sp)
            out.append(cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR))
        cr, cb = out
    return cv2.cvtColor(np.dstack([y, cr, cb]), cv2.COLOR_YCrCb2RGB)


# Temperature / tint. Each end of the slider is a per-channel curve  out = a * in**p + b  (R, G, B), fitted to
# Lightroom exports of the same photo at -100 and +100. Intermediate slider values blend the parameters
# towards the identity curve (a=1, p=1, b=0): a and p geometrically, b linearly.
_WB_TEMP = {  # -100 = cool (blue), +100 = warm (orange)
    -1: ((1.165, 1.04, -0.077), (1.24, 0.56, -0.176), (1.248, 0.20, -0.126)),
    +1: ((1.398, 0.34, -0.28), (1.223, 0.46, -0.182), (1.01, 1.05, -0.027)),
}
_WB_TINT = {  # -100 = green, +100 = magenta
    -1: ((1.045, 1.42, -0.014), (1.212, 0.53, -0.115), (0.992, 1.04, -0.015)),
    +1: ((1.057, 0.72, -0.037), (1.029, 1.05, -0.019), (1.417, 0.35, -0.334)),
}


# Per-slider strength multiplier: how far each slider moves from its default (1 = as designed). App-wide,
# edited from the cog next to each slider and kept in data/prefs.json.
STRENGTH_RANGE = (0.01, 3.0)
STRENGTH_DEFAULTS = {"texture": 0.25, "dehaze": 0.5}  # everything else defaults to 1
PREFS_PATH = os.path.join(DATA_DIR, "prefs.json")
_TUNABLE = [p for p in S.SCHEMA if p["kind"] == "slider"]


def default_strength(key):
    return STRENGTH_DEFAULTS.get(key, 1.0)


STRENGTH = {p["key"]: default_strength(p["key"]) for p in _TUNABLE}


def _clamp_strength(v, key):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default_strength(key)
    if v != v:
        return default_strength(key)
    return round(min(STRENGTH_RANGE[1], max(STRENGTH_RANGE[0], v)), 2)


def load_prefs():
    try:
        with open(PREFS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("strength") or data.get("wb_strength") or {}
    except (OSError, ValueError, AttributeError):
        raw = {}
    for k in STRENGTH:
        STRENGTH[k] = _clamp_strength(raw.get(k, default_strength(k)), k)


def set_strength(new):
    for k in STRENGTH:
        if k in new:
            STRENGTH[k] = _clamp_strength(new[k], k)
    tmp = PREFS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"strength": STRENGTH}, f)
    os.replace(tmp, PREFS_PATH)


def strength_tag():
    """Short fingerprint of the non-default multipliers, part of the thumbnail cache name."""
    changed = sorted((k, v) for k, v in STRENGTH.items() if v != default_strength(k))
    return hashlib.sha1(repr(changed).encode()).hexdigest()[:8]


def apply_strength(s):
    """Settings as rendered: each slider's distance from its default is scaled by its multiplier."""
    out = dict(s)
    for p in _TUNABLE:
        m = STRENGTH[p["key"]]
        if m != 1.0:
            v = p["default"] + (s[p["key"]] - p["default"]) * m
            out[p["key"]] = max(p["min"], v) if p["min"] >= 0 else v
    return out


load_prefs()


def _apply_wb(x, v, ends):
    if not v:
        return x
    k = abs(v)
    abp = np.array(ends[1 if v > 0 else -1], np.float32)  # (3 channels, [a, p, b])
    a, p, b = abp[:, 0] ** k, abp[:, 1] ** k, abp[:, 2] * k
    return np.clip(a * np.power(np.clip(x, 0, 1), p) + b, 0, 1).astype(np.float32)


_HAZE_LIGHT = 0.9  # fixed atmospheric light so strips/regions of one image render identically


def _dehaze(x, d, scale):
    if not d:
        return x
    if d < 0:  # add haze: blend towards a light grey veil
        k = -d * 0.4
        return (x * (1 - k) + 0.85 * k).astype(np.float32)
    dark = (x / _HAZE_LIGHT).min(-1)
    r = max(1, int(round(7 * scale)))
    dark = cv2.erode(dark, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * r + 1, 2 * r + 1)))
    dark = cv2.GaussianBlur(dark, (0, 0), max(1.0, 6 * scale))
    t = np.maximum(1 - 0.95 * d * np.clip(dark, 0, 1), 0.25)[..., None]
    return np.clip((x - _HAZE_LIGHT) / t + _HAZE_LIGHT, 0, 1).astype(np.float32)


def _channel_mix(x, s):
    """Photoshop's Channel Mixer: each output channel = a*R + b*G + c*B + constant (all in %), on encoded values.
    Monochrome uses the Gray row for all three output channels."""
    if s["mix_mono"]:
        row = [[s[f"mix_k{c}"] for c in "rgb"]] * 3
        const = [s["mix_kc"]] * 3
    else:
        row = [[s[f"mix_{o}{c}"] for c in "rgb"] for o in "rgb"]
        const = [s[f"mix_{o}c"] for o in "rgb"]
    m = np.array(row, np.float32) / 100
    if not s["mix_mono"] and np.array_equal(m, np.eye(3, dtype=np.float32)) and not any(const):
        return x
    out = x @ m.T + np.array(const, np.float32) / 100
    return np.clip(out, 0, 1).astype(np.float32)


def _presence_pad(s):
    """Extra overlap (px) needed around a strip/region so the wide blurs above don't show seams."""
    return 110 if (s.get("clarity") or s.get("dehaze")) else 0


def render(img16, s, scale=1.0, bits=8):
    """Apply develop settings. scale = this image's long edge / full-res long edge."""
    s = apply_strength(s)
    x = img16.astype(np.float32)
    x *= 1.0 / 65535.0

    if s["nr_luma"] > 0 or s["nr_color"] > 0:
        # Denoising can overshoot slightly below 0 / above 1. Negative values would become NaN in the
        # gamma step below and show up as black pixels, so clamp before going any further.
        x = np.clip(_denoise(x, s, scale), 0, 1)

    # Exposure in (approximately) linear light.
    ev = s["exposure"]
    if ev:
        np.power(x, _GAMMA, out=x)
        x *= 2.0 ** ev
        np.clip(x, 0, 1, out=x)
        np.power(x, 1.0 / _GAMMA, out=x)

    # White balance: per-channel curves on the encoded values, matched to Lightroom's ±100 results.
    x = _apply_wb(x, s["temperature"] / 100, _WB_TEMP)
    x = _apply_wb(x, s["tint"] / 100, _WB_TINT)

    # Shadows / midtones / highlights and contrast, in encoded space.
    sh, mi, hi = s["shadows"] / 100, s["midtones"] / 100, s["highlights"] / 100
    ba = [(s["shadow_amt"], s["shadow_hue"]), (s["mid_amt"], s["mid_hue"]), (s["high_amt"], s["high_hue"])]
    need_y = sh or mi or hi or any(a for a, _ in ba)
    if need_y:
        y = np.clip(_luma(x), 0, 1)
        m_sh, m_hi = (1 - y) ** 2, y ** 2
        m_mi = 4 * y * (1 - y)
        if sh or mi or hi:
            x += ((sh * m_sh + mi * m_mi + hi * m_hi) * 0.35)[..., None]
        for (amt, hue), m in zip(ba, (m_sh, m_mi, m_hi)):
            if amt:
                x += (m * (amt / 100 * 0.25))[..., None] * _hue_vec(hue)
        np.clip(x, 0, 1, out=x)
    c = s["contrast"] / 100
    if c:
        sm = x * x * (3 - 2 * x)
        x += c * (sm - x)

    # Whites / blacks: move the extreme ends of the tonal range (weighted by x^3 and (1-x)^3, so the
    # midtones barely change). Whites > 0 brightens the top end; blacks > 0 lifts the bottom end.
    wh, bl = s["whites"] / 100, s["blacks"] / 100
    if wh or bl:
        x = np.clip(x, 0, 1)
        d = np.zeros_like(x)
        if wh:
            d += (0.35 * wh) * x ** 3
        if bl:
            d += (0.25 * bl) * (1 - x) ** 3
        x = np.clip(x + d, 0, 1)

    # Presence: dehaze, clarity (local contrast), texture (fine detail). Radii are in full-resolution pixels.
    x = _dehaze(x, s["dehaze"] / 100, scale)
    cl, tx = s["clarity"] / 100, s["texture"] / 100
    if cl or tx:
        y = _luma(x)
        if cl:
            m = 4 * y * (1 - y)  # midtones only, so blacks and whites aren't pushed around
            detail = y - cv2.GaussianBlur(y, (0, 0), max(1.0, 24 * scale))
            x += (cl * 0.9 * m * detail)[..., None]
        if tx:
            detail = y - cv2.GaussianBlur(y, (0, 0), max(0.5, 2.5 * scale))
            x += (tx * 1.2 * detail)[..., None]
        np.clip(x, 0, 1, out=x)

    # Saturation / vibrance.
    sa, vi = s["saturation"] / 100, s["vibrance"] / 100
    if sa or vi:
        y = _luma(x)[..., None]
        mx, mn = x.max(-1), x.min(-1)
        cur = (mx - mn) / (mx + 1e-4)
        f = np.maximum(0, 1 + sa + vi * (1 - cur))[..., None]
        x = y + (x - y) * f
    np.clip(x, 0, 1, out=x)

    x = _channel_mix(x, s)

    # Sharpen luminance (unsharp mask).
    if s["sharp_amount"] > 0:
        y = _luma(x)
        blur = cv2.GaussianBlur(y, (0, 0), max(0.3, s["sharp_radius"] * scale))
        x += ((y - blur) * (s["sharp_amount"] / 100 * 1.5))[..., None]
        np.clip(x, 0, 1, out=x)

    if bits == 16:
        return (x * 65535 + 0.5).astype(np.uint16)
    return (x * 255 + 0.5).astype(np.uint8)


def render_banded(img16, s, scale, bits=8, band=1024, pad=64):
    """Process big images in horizontal strips with overlap to bound memory."""
    h, w = img16.shape[:2]
    if h * w <= 8_000_000:
        return render(img16, s, scale, bits)
    out = np.empty((h, w, 3), np.uint16 if bits == 16 else np.uint8)
    pad = max(pad, int(_presence_pad(s) * max(scale, 0.25)))
    for y0 in range(0, h, band):
        y1 = min(h, y0 + band)
        a, b = max(0, y0 - pad), min(h, y1 + pad)
        r = render(img16[a:b], s, scale, bits)
        out[y0:y1] = r[y0 - a:y0 - a + (y1 - y0)]
    return out


def _jpeg(rgb8, quality=88):
    ok, buf = cv2.imencode(".jpg", rgb8[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buf.tobytes()


_full = {}  # key -> full-resolution array; only the most recent image is kept


def get_full(path, key):
    with _mem_lock:
        if key in _full:
            return _full[key]
    with _key_locks["full" + key]:
        with _mem_lock:
            if key in _full:
                return _full[key]
        arr = decode(path)[0]
        with _mem_lock:
            _full.clear()
            _full[key] = arr
        return arr


def render_region(path, s, region, zoom, max_out=4096, pad_px=48):
    """Render a region of the image (normalised x, y, w, h) at `zoom` output px per full-res px.

    Uses the cached proxy when it has enough resolution, otherwise the full decode.
    Returns (jpeg bytes, actual region as normalised x, y, w, h).
    """
    proxy, fw, fh, key = get_proxy(path)
    zoom = min(1.0, max(0.02, zoom))
    src = proxy if zoom <= max(proxy.shape[:2]) / max(fw, fh) * 1.0001 else get_full(path, key)
    H, W = src.shape[:2]
    rx, ry, rw, rh = (min(1.0, max(0.0, v)) for v in region)
    x0, y0 = int(rx * W), int(ry * H)
    x1, y1 = min(W, max(x0 + 1, int(np.ceil((rx + rw) * W)))), min(H, max(y0 + 1, int(np.ceil((ry + rh) * H))))

    sa = W / fw  # source pixels per full-res pixel
    k = min(1.0, zoom / sa)  # source -> output resize factor
    longest = max(x1 - x0, y1 - y0) * k
    if longest > max_out:
        k *= max_out / longest
    scale = k * sa

    pad_px = max(pad_px, _presence_pad(s))
    pad = int(min(400, np.ceil(pad_px / max(k, 0.05))))
    px0, py0, px1, py1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    crop = src[py0:py1, px0:px1]
    if k < 0.999:
        crop = cv2.resize(crop, (max(1, round(crop.shape[1] * k)), max(1, round(crop.shape[0] * k))),
                          interpolation=cv2.INTER_AREA)
    out = render(crop, s, scale)
    tl, tt = round((x0 - px0) * k), round((y0 - py0) * k)
    tw, th = max(1, round((x1 - x0) * k)), max(1, round((y1 - y0) * k))
    out = np.ascontiguousarray(out[tt:tt + th, tl:tl + tw])
    return _jpeg(out, 88), (x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H)


def render_thumb(path, s, rev):
    arr, fw, fh, key = get_proxy(path)
    out = os.path.join(THUMB_DIR, f"{key}_{rev}_{strength_tag()}.jpg")
    if os.path.isfile(out):
        return out
    arr = resize_long(arr, THUMB_LONG)
    scale = max(arr.shape[:2]) / max(fw, fh)
    data = _jpeg(render(arr, s, scale), 82)
    for old in os.listdir(THUMB_DIR):
        if old.startswith(key + "_"):
            try:
                os.remove(os.path.join(THUMB_DIR, old))
            except OSError:
                pass
    tmp = out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, out)
    return out


def browse_thumb(path, long_edge=240):
    """Small unedited thumbnail for the file browser (cached by file key)."""
    key = file_key(path)
    out = os.path.join(THUMB_DIR, f"fs_{key}.jpg")
    if os.path.isfile(out):
        return out
    arr, _, _, _ = get_proxy(path)
    rgb8 = (resize_long(arr, long_edge) >> 8).astype(np.uint8)
    tmp = out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(_jpeg(rgb8, 80))
    os.replace(tmp, out)
    return out


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

FORMATS = {
    "jpeg": (".jpg", False),
    "png": (".png", True),
    "tiff": (".tif", True),
    "webp": (".webp", False),
}


def export_image(path, s, fmt, dest_dir, suffix="", quality=92, bits=8, long_edge=None):
    """Render at full resolution and write to dest_dir. Returns the output path."""
    if fmt not in FORMATS:
        raise ValueError(f"Unknown format {fmt}")
    ext, can16 = FORMATS[fmt]
    bits = 16 if (bits == 16 and can16) else 8

    arr, fw, fh = decode(path)
    if long_edge:
        arr = resize_long(arr, int(long_edge))
    scale = max(arr.shape[:2]) / max(fw, fh)
    out = render_banded(arr, s, scale, bits)
    del arr

    params = []
    if fmt == "jpeg":
        params = [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
    elif fmt == "webp":
        params = [cv2.IMWRITE_WEBP_QUALITY, int(quality)]
    elif fmt == "png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, 4]
    ok, buf = cv2.imencode(ext, out[..., ::-1], params)
    if not ok:
        raise RuntimeError(f"Encoding {fmt} failed")

    os.makedirs(dest_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(path))[0] + suffix
    target, n = os.path.join(dest_dir, base + ext), 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, f"{base}_{n}{ext}")
        n += 1
    with open(target, "wb") as f:
        f.write(buf.tobytes())
    return target
