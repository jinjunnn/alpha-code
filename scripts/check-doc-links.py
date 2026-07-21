#!/usr/bin/env python3
"""Lightweight docs gate: relative-link validity in changed Markdown.

For each Markdown file passed as an argument, resolve every *relative* link
target (inline `](path)` and reference `[id]: path`) against the file's
directory and assert the target exists. External links (http/https/mailto),
pure `#anchors`, and empty targets are skipped — they are not cheaply
verifiable without the network, which we deliberately keep out of the gate.

Exit 0 when every relative target resolves; exit 1 listing the broken ones.
Self-contained (stdlib only) so it runs identically in CI and locally.
"""
import os
import re
import sys

# Inline links: ](target) ; reference definitions: [id]: target
INLINE = re.compile(r"\]\(\s*(<[^>]+>|[^)\s]+)")
REFDEF = re.compile(r"^\s*\[[^\]]+\]:\s*(\S+)", re.MULTILINE)


def targets(text: str):
    for m in INLINE.finditer(text):
        yield m.group(1).strip("<>")
    for m in REFDEF.finditer(text):
        yield m.group(1)


def is_external(t: str) -> bool:
    return (
        t.startswith(("http://", "https://", "mailto:", "tel:", "#"))
        or t == ""
        or t.startswith("data:")
    )


def main(files):
    broken = []
    checked = 0
    for f in files:
        if not f.endswith(".md") or not os.path.isfile(f):
            continue
        base = os.path.dirname(f)
        with open(f, encoding="utf-8") as fh:
            text = fh.read()
        for raw in targets(text):
            if is_external(raw):
                continue
            # strip anchor / query, unescape spaces
            path = raw.split("#", 1)[0].split("?", 1)[0].replace("%20", " ")
            if not path:
                continue  # pure in-page anchor
            resolved = os.path.normpath(os.path.join(base, path))
            checked += 1
            if not os.path.exists(resolved):
                broken.append((f, raw, resolved))
    if broken:
        print(f"✗ {len(broken)} broken relative link(s) (of {checked} checked):")
        for src, raw, resolved in broken:
            print(f"  {src}: [{raw}] -> {resolved} (missing)")
        return 1
    print(f"✓ {checked} relative link(s) resolve across {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
