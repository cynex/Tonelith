"""Rebuild every icon from images/Tonelith_icon.png.   Run:  .venv\\Scripts\\python tools\\make_icons.py

Writes:
  images/Tonelith.ico              Windows application icon (16-256 px)
  images/Tonelith.icns             macOS application icon
  static/icons/icon-*.png          browser tab, installed-app and header icons
"""
import io
import os
import struct

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "images", "Tonelith_icon.png")
WEB = os.path.join(ROOT, "static", "icons")
os.makedirs(WEB, exist_ok=True)

src = Image.open(SRC).convert("RGBA")

# The artwork has a wide transparent margin plus a soft shadow. Crop to the solid tile so small icons aren't tiny.
alpha = np.asarray(src)[..., 3]
ys, xs = np.where(alpha > 200)
x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
side = max(x1 - x0, y1 - y0)
pad = round(side * 0.025)  # a sliver of breathing room so the rounded corners aren't clipped
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
half = side / 2 + pad
box = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
tile = Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
tile.paste(src, (-box[0], -box[1]))  # pasting (not cropping) keeps it square even near the image edge


def at(size):
    return tile.resize((size, size), Image.LANCZOS)


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---- web icons
for size in (32, 96, 180, 192, 512):
    at(size).save(os.path.join(WEB, f"icon-{size}.png"), optimize=True)

# ---- Windows .ico: one PNG-compressed image per size, each resampled from the original for crisp small sizes
sizes = [16, 24, 32, 48, 64, 128, 256]
blobs = [png_bytes(at(s)) for s in sizes]
header = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b""
for s, data in zip(sizes, blobs):
    entries += struct.pack("<BBBBHHII", 0 if s >= 256 else s, 0 if s >= 256 else s, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
with open(os.path.join(ROOT, "images", "Tonelith.ico"), "wb") as f:
    f.write(header + entries + b"".join(blobs))

# ---- macOS .icns
at(1024).save(os.path.join(ROOT, "images", "Tonelith.icns"), format="ICNS")

print("icons written; crop box", box, "->", tile.size)
