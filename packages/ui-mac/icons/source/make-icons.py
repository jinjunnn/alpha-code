#!/usr/bin/env python3
"""Regenerate the alpha-code app icon set from this folder's icon.png (the brand <α> squircle).

Run:  python3 packages/ui-mac/icons/source/make-icons.py
Then: bun --cwd packages/ui-mac run ship:mac   # prebuild copies icons/<channel>/ → resources/icons

The source is a black squircle on a WHITE background with a WHITE glyph inside. The non-obvious bit:
we knock out the background by flood-filling from the four CORNERS (so the enclosed white glyph
survives — a blanket white→transparent would punch holes in it), then fit the squircle to Apple's
824/1024 grid and emit icon.icns + sized PNGs into every channel (dev/beta/prod)."""
import os, shutil, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.dirname(HERE)               # packages/ui-mac/icons
SRC = os.path.join(HERE, "icon.png")
WORK = tempfile.mkdtemp(prefix="alpha-icons-")

src = Image.open(SRC).convert("RGBA")
W, H = src.size

# 1) Background → transparent via corner flood-fill (preserves the enclosed glyph).
rgb = src.convert("RGB")
MARK = (255, 0, 255)
for corner in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]:
    ImageDraw.floodfill(rgb, corner, MARK, thresh=70)
mask = Image.new("L", (W, H), 255)
rp, mp = rgb.load(), mask.load()
for y in range(H):
    for x in range(W):
        if rp[x, y] == MARK:
            mp[x, y] = 0
mask = mask.filter(ImageFilter.GaussianBlur(0.6))
squircle = src.copy()
squircle.putalpha(mask)

# 2) Fit to Apple's grid: content 824 centered on a 1024 transparent canvas.
bbox = squircle.getbbox()
cropped = squircle.crop(bbox)
cw, ch = cropped.size
side = max(cw, ch)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(cropped, ((side - cw) // 2, (side - ch) // 2))
CANVAS, CONTENT = 1024, 824
master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
off = (CANVAS - CONTENT) // 2
master.paste(sq.resize((CONTENT, CONTENT), Image.LANCZOS), (off, off))

# 3) icon.icns
iconset = os.path.join(WORK, "icon.iconset")
os.makedirs(iconset)
for base, scale in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]:
    px = base * scale
    nm = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
    master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, nm))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(WORK, "icon.icns")], check=True)

# 4) Flat PNGs
master.save(os.path.join(WORK, "icon.png"))
for px, name in [(512, "dock.png"), (32, "32x32.png"), (64, "64x64.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
    master.resize((px, px), Image.LANCZOS).save(os.path.join(WORK, name))

# 5) Copy into every channel
FILES = ["icon.icns", "icon.png", "dock.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png"]
for ch in ["dev", "beta", "prod"]:
    for f in FILES:
        shutil.copy(os.path.join(WORK, f), os.path.join(ICONS, ch, f))
shutil.rmtree(WORK, ignore_errors=True)
print("icons regenerated for dev/beta/prod — now run ship:mac")
