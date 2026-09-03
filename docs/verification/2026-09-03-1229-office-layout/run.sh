#!/usr/bin/env bash
# #1229 —— 右栏 Office 版式载体的真 Chromium 判据。
#
#   bash docs/verification/2026-09-03-1229-office-layout/run.sh <docx> <pptx> <xlsx>
#
# 三个真实文件是**必填**的。仓内 fixtures/office-containers 那三个容器**不能**用来判版式:
# 它们是为提取路造的最小 OPC 包(只有 document.xml / slides / worksheets),没有
# slideLayouts / slideMasters / theme —— 版式渲染库据此判定「这不是一份可渲染的演示文稿」,
# 实测 pptx 直接 `no slides rendered`。拿它当输入会得到一个**与代码无关的红**,
# 那正是本仓反复付过学费的形态,所以这里宁可不给默认值。
#
# 被测对象:生产模块 rail-preview-host.ts + 生产宿主页产物 out/office-preview/。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
UI="$REPO/packages/ui-mac"

ELECTRON=""
MAIN_CHECKOUT="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
for c in "$UI/node_modules/electron" "$REPO/node_modules/electron" "$REPO"/node_modules/.bun/electron@*/node_modules/electron \
         "$MAIN_CHECKOUT/packages/ui-mac/node_modules/electron"; do
  [ -x "$c/dist/Electron.app/Contents/MacOS/Electron" ] && { ELECTRON="$c/dist/Electron.app/Contents/MacOS/Electron"; break; }
done
[ -n "$ELECTRON" ] || { echo "找不到可执行的 electron(dist/ 未下载)" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
APP="$WORK/app"; WS="$WORK/ws"
mkdir -p "$APP" "$WS"

# 宿主页产物:跑生产那条打包步骤,不手抄。
( cd "$UI" && bun ./scripts/build-office-preview.ts >/dev/null )
mkdir -p "$APP/out"
cp -R "$UI/out/office-preview" "$APP/out/office-preview"
cp "$HERE/harness/main.cjs" "$HERE/harness/package.json" "$APP/"
( cd "$UI" && bun build src/main/rail-preview-host.ts --target=node --format=cjs --external electron --outfile "$APP/probe-bundle.cjs" >/dev/null )

if [ $# -lt 3 ]; then
  echo "用法:run.sh <真实.docx> <真实.pptx> <真实.xlsx>(理由见本文件抬头)" >&2
  exit 2
fi
cp "$1" "$WS/probe.docx"; cp "$2" "$WS/probe.pptx"; cp "$3" "$WS/probe.xlsx"

mkdir -p "$HERE/results"
STATUS=0
for f in docx pptx xlsx; do
  echo "── office-$f ─────────────────────────────"
  set +e
  "$ELECTRON" "$APP" --ws="$WS" --rel="probe.$f" --kind="office-$f" --out="$HERE/results/$f.png" 2>/dev/null
  rc=$?
  set -e
  [ $rc -ne 0 ] && STATUS=$rc
done
echo "→ results/{docx,pptx,xlsx}.{json,png}"
exit $STATUS
