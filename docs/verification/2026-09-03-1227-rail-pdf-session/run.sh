#!/usr/bin/env bash
# #1227 —— 右栏 PDF 叠放载体的真 Chromium 判据。
#
#   bash docs/verification/2026-09-03-1227-rail-pdf-session/run.sh            # 判当前工作树
#   bash docs/verification/2026-09-03-1227-rail-pdf-session/run.sh HEAD~1     # 判某个 ref(取红对照)
#
# 被测对象是生产模块本身:packages/ui-mac/src/main/rail-preview-host.ts 经 bun build 打成
# probe-bundle.cjs(electron 外置),harness/main.cjs 直接 require 它并调 openRailPreview。
# 产物落在 results/:<tag>.png(叠放 view 的位图)+ <tag>.json(判据数值)。
set -euo pipefail

REF="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
UI="$REPO/packages/ui-mac"
TAG="${REF:-after}"
TAG="${TAG//\//-}"

# electron 的二进制是 postinstall 下载的,worktree 里常常只有包没有 dist ——
# 逐个候选找,找不到就明说,不要拿一个「跑不起来 = 绿」的空结论糊过去。
ELECTRON=""
# worktree 的 node_modules 里通常只有包、没有 dist;主 checkout 有,故把它也算进候选。
MAIN_CHECKOUT="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
for candidate in \
  "$UI/node_modules/electron" \
  "$REPO/node_modules/electron" \
  "$REPO"/node_modules/.bun/electron@*/node_modules/electron \
  "$MAIN_CHECKOUT/packages/ui-mac/node_modules/electron" \
  "$MAIN_CHECKOUT/node_modules/electron"
do
  bin="$candidate/dist/Electron.app/Contents/MacOS/Electron"
  [ -x "$bin" ] && { ELECTRON="$bin"; break; }
done
if [ -z "$ELECTRON" ]; then
  echo "找不到可执行的 electron(dist/ 未下载)。在装好 electron dist 的 checkout 里跑,或先 bun install。" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 一份最小但真实的单页 PDF(可见文本 + 一条描边),现生成,不进仓。
python3 - "$WORK/probe.pdf" <<'PY'
import sys
content = b'BT /F1 36 Tf 72 700 Td (HELLO-PDF-PROBE) Tj ET 1 0 0 RG 8 w 72 100 m 500 100 l S'
objs = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]
out = b'%PDF-1.4\n'
offsets = []
for i, o in enumerate(objs, 1):
    offsets.append(len(out))
    out += str(i).encode() + b' 0 obj\n' + o + b'\nendobj\n'
xref = len(out)
out += b'xref\n0 ' + str(len(objs) + 1).encode() + b'\n0000000000 65535 f \n'
for off in offsets:
    out += ('%010d 00000 n \n' % off).encode()
out += b'trailer\n<< /Size ' + str(len(objs) + 1).encode() + b' /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'
open(sys.argv[1], 'wb').write(out)
PY

SRC="$UI/src/main/rail-preview-host.ts"
if [ -n "$REF" ]; then
  # 取旧版做红对照时,必须把它放回**源码树里**再打包 —— 它的相对 import
  # (./logging、./workspace-file-service、../shared/file-viewer)只有在原位才解析得开。
  SRC="$UI/src/main/.rail-preview-host.probe.ts"
  git -C "$REPO" show "$REF:packages/ui-mac/src/main/rail-preview-host.ts" > "$SRC"
  trap 'rm -rf "$WORK"; rm -f "$UI/src/main/.rail-preview-host.probe.ts"' EXIT
fi

( cd "$UI" && bun build "$SRC" --target=node --format=cjs --external electron --outfile "$HERE/harness/probe-bundle.cjs" >/dev/null )

mkdir -p "$HERE/results"
set +e
"$ELECTRON" "$HERE/harness" --ws="$WORK" --out="$HERE/results/$TAG.png" --rel=probe.pdf 2>/dev/null
STATUS=$?
set -e
rm -f "$HERE/harness/probe-bundle.cjs"
echo "→ results/$TAG.json / results/$TAG.png"
exit $STATUS
