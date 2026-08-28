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

THE SMALL-SIZE KEYLINE (`ac#1160` round 2, owner-requested)
-----------------------------------------------------------
The outgoing brand was a BLACK squircle: a hard silhouette on any background. This one is a
CREAM tile, and cream against a light window is not a silhouette at all — measured WCAG
contrast of the tile (254,239,210) against macOS light chrome #f6f6f6 is **1.05:1**, against
pure white **1.14:1**. Against dark chrome it is 15.3:1, which is why the mark looks *better*
in dark mode and why the defect only shows up in one half of the ladder.

At 128px and up that does not matter much: the glyph is legible, so the mark is identifiable
even when its outer edge is not. At 16-32px the glyph is a few pixels of mush and the edge is
all the mark has — so on a light background the icon reads as a vague blue smudge with no
shape. Fix: paint a keyline of the artwork's own ink colour along the inside of the squircle
edge. Ink on #f6f6f6 is 7.5:1, so the shape comes back.

Two decisions worth keeping:
  * the line is **1 DEVICE pixel**, not a fraction of the artwork. A line that scaled with the
    icon would be ~16px at 256 and would read as a new, heavier brand; at 1 device pixel it is
    load-bearing at 16px, a hairline at 64px, and nothing at all above that. It also lands
    correctly on retina for free: `icon_16x16@2x` is a 32px raster shown at 16pt, so its 1px
    line is the 0.5pt hairline that size wants.
  * it stops at `KEYLINE_MAX_PX` = 128. Above that 1px is under 0.8% of the icon — it cannot
    fix the contrast (nothing 1px wide can) and it is not free, because the 256/512/1024
    renderings are the artwork the owner reviewed and accepted. Capping it keeps `icon.png`
    (1024), `dock.png` (512) and `128x128@2x.png` (256) byte-identical to that approval.

No test can judge this; the evidence is the before/after contact sheet in the `ac#1160` PR.
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
KEYLINE_PX = 1.0  # keyline width, in DEVICE pixels of the size being written (not artwork units)
KEYLINE_MAX_PX = 128  # above this the line is <0.8% of the icon and does nothing — see below

src = Image.open(SRC).convert("RGB")
W, H = src.size

# 0) Tile colour = the modal colour of the four 32x32 corner patches. The artwork carries a
#    faint paper grain (measured +/-3 levels), so a single sampled pixel is not the colour.
counts = Counter()
for bx, by in [(0, 0), (W - 32, 0), (0, H - 32), (W - 32, H - 32)]:
    counts.update(src.crop((bx, by, bx + 32, by + 32)).getdata())
TILE = counts.most_common(1)[0][0]

# 0b) Ink colour = the modal colour among pixels that are NOT the tile. Used only by the
#     keyline (step 2b). Derived rather than hard-coded so that re-arting the source cannot
#     leave a stale hex behind; measured 2026-08-28 on the shipped source: (45, 74, 144).
ink_counts = Counter()
for pixel in src.getdata():
    if sum(abs(a - b) for a, b in zip(pixel, TILE)) > 120:
        ink_counts[pixel] += 1
if not ink_counts:
    raise SystemExit("no non-tile pixels — the source is a flat colour, check TILE")
INK = ink_counts.most_common(1)[0][0]

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


def keyline_alpha(size: int, width: float) -> Image.Image:
    """Coverage of a `width`-device-pixel band lying just INSIDE the squircle edge.

    Rasterised in canvas coordinates (the content box is CONTENT/CANVAS of the canvas) so it
    lands on exactly the curve `squircle_mask` produced, whatever `size` is — 824/1024 does
    not divide evenly into 16, and rounding the content box to whole pixels first would put
    the line half a pixel off the edge it is supposed to trace.
    """
    big = size * SUPERSAMPLE
    c = big / 2.0
    outer = big * CONTENT / CANVAS / 2.0
    inner = outer - width * SUPERSAMPLE
    band = Image.new("L", (big, big), 0)
    px = band.load()
    for y in range(big):
        dy = abs((y + 0.5) - c)
        if dy >= outer:
            continue
        xo = (1.0 - (dy / outer) ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N) * outer
        xi = 0.0
        if inner > 0 and dy < inner:
            xi = (1.0 - (dy / inner) ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N) * inner
        lo, hi = max(0, int(round(c - xo))), min(big, int(round(c + xo)))
        ilo, ihi = int(round(c - xi)), int(round(c + xi))
        for x in range(lo, hi):
            if xi > 0.0 and ilo <= x < ihi:
                continue
            px[x, y] = 255
    return band.resize((size, size), Image.LANCZOS)


def render(size: int) -> Image.Image:
    """The master at `size`, keylined if the line is big enough there to be worth drawing."""
    if size == CANVAS:
        return master
    out = master.resize((size, size), Image.LANCZOS)
    if size > KEYLINE_MAX_PX:
        return out
    band = Image.new("RGBA", (size, size), INK + (255,))
    band.putalpha(keyline_alpha(size, KEYLINE_PX))
    footprint = out.getchannel("A")
    out = Image.alpha_composite(out, band)
    # The keyline paints strictly inside the squircle; restoring the pre-composite alpha
    # keeps the silhouette's footprint (and its antialiased fringe) byte-for-byte the shape
    # it already was — the line changes what colour the edge is, never where the edge is.
    out.putalpha(footprint)
    return out


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
    render(px).save(os.path.join(iconset, nm))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(WORK, "icon.icns")], check=True)

# 4) icon.ico — electron-builder's win.icon / nsis.installerIcon. Pillow's ICO writer, sizes
#    chosen to match the icon.ico that shipped before this script owned it.
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
# Pillow's ICO writer only emits a frame for a size it was handed (or can thumbnail DOWN to
# from the base image), and it skips any size larger than the base — so the base has to be the
# largest entry, with the rest appended explicitly. Handing it every frame is also what keeps
# the keyline in: left to itself it would thumbnail all six out of the un-keylined master.
ico_frames = [render(w) for w, _ in ICO_SIZES]
ico_frames[-1].save(
    os.path.join(WORK, "icon.ico"), format="ICO", sizes=ICO_SIZES, append_images=ico_frames[:-1]
)

# 5) Flat PNGs — icon.png/dock.png are read at runtime, the rest are electron-builder's linux set.
master.save(os.path.join(WORK, "icon.png"))
for px, name in [(512, "dock.png"), (32, "32x32.png"), (64, "64x64.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
    render(px).save(os.path.join(WORK, name))

# 6) Copy into every channel
FILES = ["icon.icns", "icon.ico", "icon.png", "dock.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png"]
for ch in ["dev", "beta", "prod"]:
    for f in FILES:
        shutil.copy(os.path.join(WORK, f), os.path.join(ICONS, ch, f))
shutil.rmtree(WORK, ignore_errors=True)
print(
    f"tile={TILE} ink={INK} glyph_bbox={bbox} keyline={KEYLINE_PX}px<={KEYLINE_MAX_PX} "
    f"— {len(FILES)} files regenerated for dev/beta/prod; now run ship:mac"
)
