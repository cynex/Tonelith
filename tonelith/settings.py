"""Develop settings schema: single source of truth for the server and the UI."""
import hashlib
import json
import math

_WB, _TONE, _PRES, _BAL = "White Balance", "Tone", "Presence", "Color Balance"
_SHARP, _NR = "Sharpening", "Noise Reduction"


def _s(key, label, section, lo, hi, step, default=0, kind="slider"):
    return dict(key=key, label=label, section=section, min=lo, max=hi,
                step=step, default=default, kind=kind)


SCHEMA = [
    _s("temperature", "Temperature", _WB, -100, 100, 1),
    _s("tint", "Tint", _WB, -100, 100, 1),

    _s("exposure", "Exposure", _TONE, -5, 5, 0.01),
    _s("contrast", "Contrast", _TONE, -100, 100, 1),
    _s("highlights", "Highlights", _TONE, -100, 100, 1),
    _s("midtones", "Midtones", _TONE, -100, 100, 1),
    _s("shadows", "Shadows", _TONE, -100, 100, 1),
    _s("whites", "Whites", _TONE, -100, 100, 1),
    _s("blacks", "Blacks", _TONE, -100, 100, 1),

    _s("texture", "Texture", _PRES, -100, 100, 1),
    _s("clarity", "Clarity", _PRES, -100, 100, 1),
    _s("dehaze", "Dehaze", _PRES, -100, 100, 1),
    _s("vibrance", "Vibrance", _PRES, -100, 100, 1),
    _s("saturation", "Saturation", _PRES, -100, 100, 1),

    _s("shadow_hue", "Shadows Hue", _BAL, 0, 360, 1, 220, "hue"),
    _s("shadow_amt", "Shadows Amount", _BAL, 0, 100, 1),
    _s("mid_hue", "Midtones Hue", _BAL, 0, 360, 1, 40, "hue"),
    _s("mid_amt", "Midtones Amount", _BAL, 0, 100, 1),
    _s("high_hue", "Highlights Hue", _BAL, 0, 360, 1, 40, "hue"),
    _s("high_amt", "Highlights Amount", _BAL, 0, 100, 1),

    _s("sharp_amount", "Amount", _SHARP, 0, 150, 1),
    _s("sharp_radius", "Radius", _SHARP, 0.5, 3, 0.1, 1.0),

    _s("nr_luma", "Luminance", _NR, 0, 100, 1),
    _s("nr_color", "Color", _NR, 0, 100, 1),
]

DEFAULTS = {p["key"]: p["default"] for p in SCHEMA}
_BY_KEY = {p["key"]: p for p in SCHEMA}


def normalize(raw):
    """Return a complete, clamped settings dict. Unknown keys are dropped."""
    out = {}
    raw = raw if isinstance(raw, dict) else {}
    for p in SCHEMA:
        try:
            v = float(raw.get(p["key"], p["default"]))
        except (TypeError, ValueError):
            v = p["default"]
        if not math.isfinite(v):
            v = p["default"]
        v = min(p["max"], max(p["min"], v))
        out[p["key"]] = round(v, 2)
    return out


def is_default(settings):
    return normalize(settings) == normalize({})


def revision(settings):
    blob = json.dumps(normalize(settings), sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:10]
