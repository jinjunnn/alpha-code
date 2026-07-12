#!/usr/bin/env bash
# ADR-027/REQ-084 验收 #8:模拟 sync-upstream.yml 的 restore_frozen_frontend 步骤,
# 证明从冻结 tag 还原后 typed surface seam 及其锚点仍存活。用法:
#   bash scripts/verify-freeze-restore.sh [tag]   # 默认 frontend-freeze-base-2
# 也是未来 re-freeze(ADR-020 §5 ③)体检步骤的一部分。
set -euo pipefail

TAG="${1:-frontend-freeze-base-2}"
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d /tmp/freeze-restore.XXXXXX)"
cleanup() {
  git -C "$root" worktree remove --force "$tmp" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$root" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || {
  echo "FAIL: tag $TAG does not exist" >&2
  exit 1
}

echo "== simulating restore_frozen_frontend from $TAG in a temp worktree =="
git -C "$root" worktree add --detach "$tmp" HEAD >/dev/null 2>&1
cd "$tmp"
rm -rf packages/app packages/ui
git checkout "$TAG" -- packages/app packages/ui

# 与 sync-upstream.yml 相同的 loud-fail marker 校验
grep -q "AppSurfaces" packages/app/src/app.tsx || {
  echo "FAIL: ADR-027 seam marker (AppSurfaces) missing after restore from $TAG" >&2
  exit 1
}

# seam 锚点逐条核验(与 surface-seam-contract.test.ts 同一契约)
for anchor in \
  "export interface AppSurfaces" \
  "export interface DraftSurfaceProps" \
  "surfaces?: AppSurfaces" \
  "props.surfaces?.home ?? HomeRoute" \
  "preload: () => Leaf.preload?.()"; do
  grep -qF "$anchor" packages/app/src/app.tsx || {
    echo "FAIL: seam anchor missing after restore: $anchor" >&2
    exit 1
  }
done

# 还原内容必须与当前 HEAD 的冻结集一致(tag 即本基点)
if ! git diff --quiet HEAD -- packages/app packages/ui; then
  echo "FAIL: restored packages/app|ui differ from HEAD freeze set" >&2
  git diff --stat HEAD -- packages/app packages/ui >&2
  exit 1
fi

echo "OK: seam and all anchors survive restore from $TAG; restored trees match HEAD freeze set"
