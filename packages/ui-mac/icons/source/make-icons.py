#!/usr/bin/env python3
"""Regenerate the app icon set from this folder's icon.png (the Code Puppy brand mark).

Run:  python3 packages/ui-mac/icons/source/make-icons.py
Then: bun --cwd packages/ui-mac run ship:mac   # prebuild copies icons/<channel>/ → resources/icons

Requires Pillow (`pip install Pillow`) and macOS `iconutil` (for icns).

WHY THIS SCRIPT CHANGED (`ac#1160`, 2026-08-28)
-----------------------------------------------
The previous source was a BLACK squircle on a WHITE background with a WHITE glyph inside,
so the whole pipeline was "knock the background out and the squircle *is* the icon": four
corner flood-fills (so the enclosed white glyph survives a blanket white→transparent), then
fit the surviving silhouette to Apple's 824/1024 grid.

The Code Puppy source is a different shape of input: a FULL-BLEED cream tile with a dark blue
pixel glyph (dog + `>-` prompt) that occupies only 495x405 of 1024. The knockout still works
mechanically on it — measured 2026-08-28: 86.6% of pixels knocked out, the enclosed cream face
survives, bbox (265,304,760,709) — but the *result* is wrong twice over: it emits a free-form
floating glyph instead of the squircle every other size of this app has shipped as, and it
bakes the artwork's own 25% dead margin into the 824 grid so the mark is small at every size.

So the knockout is kept, and demoted: it now MEASURES the glyph (bbox + alpha) and no longer
decides the icon's silhouette. The silhouette is an explicit n=5 superellipse — measured off
the previously shipped icon.png, whose corner profile fits n = 5.00 (median over 42 scanlines).
"""
import os
import shutil
import subprocess
import tempfile
from collections import Counter

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.dirname(HERE)  # packages/ui-mac/icons
SRC = os.path.join(HERE, "icon.png")
WORK = tempfile.mkdtemp(prefix="alpha-icons-")

CANVAS = 1024  # full icon canvas
CONTENT = 824  # Apple's content box inside it
SQUIRCLE_N = 5.0  # superellipse exponent; matches the previously shipped squircle
GLYPH_SCALE = 0.78  # glyph long edge / CONTENT — see the visual sheet in the ac#1160 PR
SUPERSAMPLE = 4  # mask is drawn at 4x and resampled, so the curve has no stair-steps
FLOOD_THRESH = 70  # unchanged from the previous script

src = Image.open(SRC).convert("RGB")
W, H = src.size

# 0) Tile colour = the modal colour of the four 32x32 corner patches. The artwork carries a
#    faint paper grain (measured +/-3 levels), so a single sampled pixel is not the colour.
counts = Counter()
for bx, by in [(0, 0), (W - 32, 0), (0, H - 32), (W - 32, H - 32)]:
    counts.update(src.crop((bx, by, bx + 32, by + 32)).getdata())
TILE = counts.most_common(1)[0][0]

# 1) Corner flood-fill → glyph alpha. Enclosed interior regions survive (that is the whole
#    point of filling from the corners rather than keying the background colour globally).
probe = src.copy()
MARK = (255, 0, 255)
for corner in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]:
    ImageDraw.floodfill(probe, corner, MARK, thresh=FLOOD_THRESH)
mask = Image.new("L", (W, H), 255)
pp, mp = probe.load(), mask.load()
for y in range(H):
    for x in range(W):
        if pp[x, y] == MARK:
            mp[x, y] = 0
mask = mask.filter(ImageFilter.GaussianBlur(0.6))
glyph = src.convert("RGBA")
glyph.putalpha(mask)
bbox = glyph.getbbox()
if bbox is None:
    raise SystemExit("flood-fill knocked out every pixel — check FLOOD_THRESH against the source")
glyph = glyph.crop(bbox)


def squircle_mask(size: int) -> Image.Image:
    """|x|^n + |y|^n = 1 rasterised at SUPERSAMPLE x, then box-filtered down."""
    big = size * SUPERSAMPLE
    im = Image.new("L", (big, big), 0)
    px = im.load()
    r = big / 2.0
    for y in range(big):
        yn = (abs((y + 0.5) - r) / r) ** SQUIRCLE_N
        if yn >= 1.0:
            continue
        xr = (1.0 - yn) ** (1.0 / SQUIRCLE_N) * r
        for x in range(max(0, int(round(r - xr))), min(big, int(round(r + xr)))):
            px[x, y] = 255
    return im.resize((size, size), Image.LANCZOS)


# 2) Compose the master: flat tile → glyph centred at GLYPH_SCALE → squircle alpha → 824/1024.
tile = Image.new("RGBA", (CONTENT, CONTENT), TILE + (255,))
gw, gh = glyph.size
k = (CONTENT * GLYPH_SCALE) / max(gw, gh)
placed = glyph.resize((max(1, round(gw * k)), max(1, round(gh * k))), Image.LANCZOS)
tile.alpha_composite(placed, ((CONTENT - placed.size[0]) // 2, (CONTENT - placed.size[1]) // 2))
tile.putalpha(squircle_mask(CONTENT))
master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
master.paste(tile, ((CANVAS - CONTENT) // 2, (CANVAS - CONTENT) // 2))

# 3) icon.icns — the ten variants macOS actually asks for, 16 through 1024.
iconset = os.path.join(WORK, "icon.iconset")
os.makedirs(iconset)
for base, scale in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]:
    px = base * scale
    nm = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
    master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, nm))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(WORK, "icon.icns")], check=True)

# 4) icon.ico — electron-builder's win.icon / nsis.installerIcon. Pillow's ICO writer, sizes
#    chosen to match the icon.ico that shipped before this script owned it.
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
master.save(os.path.join(WORK, "icon.ico"), format="ICO", sizes=ICO_SIZES)

# 5) Flat PNGs — icon.png/dock.png are read at runtime, the rest are electron-builder's linux set.
master.save(os.path.join(WORK, "icon.png"))
for px, name in [(512, "dock.png"), (32, "32x32.png"), (64, "64x64.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
    master.resize((px, px), Image.LANCZOS).save(os.path.join(WORK, name))

# 6) Copy into every channel
FILES = ["icon.icns", "icon.ico", "icon.png", "dock.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png"]
for ch in ["dev", "beta", "prod"]:
    for f in FILES:
        shutil.copy(os.path.join(WORK, f), os.path.join(ICONS, ch, f))
shutil.rmtree(WORK, ignore_errors=True)
print(f"tile={TILE} glyph_bbox={bbox} — {len(FILES)} files regenerated for dev/beta/prod; now run ship:mac")
