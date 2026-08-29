# App icons

## Layout

```
source/icon.png        the brand master — 1024x1024, the ONLY hand-authored file here
source/make-icons.py   regenerates everything below from it
dev/ beta/ prod/       one folder per channel; scripts/copy-icons.ts copies the whole folder
                       to resources/icons at prebuild (rm -rf then cp -R)
```

`resources/icons` is a **generated** directory and is not under version control
(`ac#1115`; `src/main/alpha-generated-icons-hygiene.test.ts` is the gate). The channel
folders here *are* tracked — they are the input.

## The eight files Electron actually consumes

A channel folder holds exactly these eight, and `make-icons.py` writes exactly these eight
(see *What is not here* below for what used to sit alongside them):

| file | px | consumer |
| --- | --- | --- |
| `icon.icns` | 10 variants, 16→1024 | `electron-builder.config.ts` `mac.icon` |
| `icon.ico` | 16/32/48/64/128/256 | `electron-builder.config.ts` `win.icon`, `nsis.installerIcon`, `nsis.installerHeaderIcon`; `windows.ts` `iconPath()` on win32 |
| `icon.png` | 1024 | `windows.ts` `iconPath()` off win32 (BrowserWindow icon) |
| `dock.png` | 512 | `windows.ts` — `nativeImage.createFromPath` for the unpackaged Dock icon |
| `32x32.png` `64x64.png` `128x128.png` `128x128@2x.png` | 32/64/128/256 | `electron-builder.config.ts` `linux.icon` points at the **directory**; electron-builder picks these up by filename |

## Regenerating

```
python3 packages/ui-mac/icons/source/make-icons.py
bun --cwd packages/ui-mac run ship:mac
```

Toolchain, as measured on 2026-08-28 (`ac#1160`):

- **Pillow** does the compositing, the resampling (LANCZOS everywhere) and, since `ac#1160`,
  the **`.ico` writing** (`Image.save(..., format="ICO", sizes=[...])`). Before that the
  `.ico` was a one-off hand export with no recorded provenance and the script did not
  produce it at all. Verified against `/usr/bin/python3` 3.9.6 + Pillow 11.3.0.
- **`iconutil -c icns`** (macOS, `/usr/bin/iconutil`) does the `.icns`, from a ten-entry
  `.iconset`. Round-trip `iconutil -c iconset` back out to confirm all ten survived.
- No ImageMagick, no Image2Icon, no `tauri icon`. The previous version of this file
  described a Tauri + Image2Icon workflow that has not been how these are built for a long
  time; it is gone.

## How the master is composed

The source is a full-bleed cream tile with a dark blue pixel glyph occupying only part of
it, so the script cannot simply knock the background out and ship the silhouette (that was
right for the previous black-squircle-on-white brand, and is wrong for this one — it emits
a free-form floating glyph and bakes the artwork's own dead margin into Apple's grid).

Instead:

1. four corner flood-fills (`thresh=70`) → glyph alpha + bbox. Filling from the *corners*
   rather than keying the background colour globally is what lets enclosed same-colour
   regions (the dog's face) survive. This step now only **measures** the glyph.
2. tile of the modal corner colour, at Apple's 824 content box;
3. glyph pasted centred at `GLYPH_SCALE` (0.78) of that box;
4. alpha = an n=5 superellipse — the squircle exponent measured off the previously shipped
   `icon.png` (median n = 5.00 over 42 scanlines), so the silhouette is unchanged;
5. the 824 tile centred on a 1024 transparent canvas.

`GLYPH_SCALE` is the one knob worth touching. Above ~0.85 the ears reach the squircle edge;
below ~0.65 the mark is lost at 16 px.

## The small-size keyline

The outgoing brand was a black squircle — a hard silhouette on any background. This one is a
cream tile, and cream has no silhouette on light chrome: measured WCAG contrast of the tile
`(254,239,210)` against macOS light `#f6f6f6` is **1.05:1** (against white, 1.14:1). Against
dark chrome it is **15.3:1**, which is why the mark looks better in dark mode and why the
problem only shows in half the ladder.

So every raster of **128 px or less** gets a **1-device-pixel keyline** of the artwork's own
ink colour, painted just inside the squircle edge (`KEYLINE_PX` / `KEYLINE_MAX_PX`). Ink on
`#f6f6f6` is 7.5:1, so the shape comes back. Measured over the shipped files, edge contrast
against `#f6f6f6` on the mid-height scanline:

| raster | before | after |
| --- | --- | --- |
| 16 / 32 / 48 / 64 / 128 px | 1.06:1 (16 px: 1.90) | 2.7 – 4.6:1 |
| 256 / 512 / 1024 px | 1.05–1.06:1 | **unchanged, byte-identical** |

Two things about that rule are deliberate:

- The line is **1 device pixel, not a fraction of the artwork.** Scaled with the icon it would
  be ~16 px at 256 and would read as a new, heavier brand. At one device pixel it is
  load-bearing at 16 px, a hairline at 64 px, and nothing above. It also lands right on retina
  for free — `icon_16x16@2x` is a 32 px raster shown at 16 pt, so its 1 px line is the 0.5 pt
  hairline that size wants.
- It **stops at 128 px.** Above that, 1 px is under 0.8% of the icon: it cannot fix the
  contrast (nothing 1 px wide can) and it is not free, because those renderings are the
  artwork that was reviewed and accepted. The cap is what keeps `icon.png` (1024),
  `dock.png` (512) and `128x128@2x.png` (256) byte-identical to that approval.

The cost, stated plainly: at **16 px @1x on dark chrome** the keyline eats about a pixel of
cream and the tile reads slightly muddier than before. That raster is only used on non-retina
displays; the retina path (`icon_16x16@2x`, 32 px) is unaffected. No test judges any of this —
the evidence is the contact sheet on the `ac#1160` PR.

## What is not here

Each channel folder holds exactly the eight files above. The `Square*Logo.png`, `StoreLogo.png`,
`android/` and `ios/` sets that used to sit alongside them were Tauri-era output with zero
consumers in this repo (two independent searches: no reference from any `.ts`/`.json`/`.yml`,
and `electron-builder.config.ts` names only `icon.icns` / `icon.ico` / the `resources/icons`
directory). They were never regenerated by `make-icons.py`, so after the Code Puppy re-art they
were the only remaining copies of the old mark. Deleted in `ac#1160`. If a Windows Store or
mobile target ever comes back, generate them then — from this same master.
