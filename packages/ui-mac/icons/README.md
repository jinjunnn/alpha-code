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

Everything else in a channel folder (`Square*Logo.png`, `StoreLogo.png`, `android/`,
`ios/`) is inert Tauri-era residue with zero consumers. `make-icons.py` writes these eight
and nothing else:

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
