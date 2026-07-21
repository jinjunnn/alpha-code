# 前端 pin + 补丁(ADR-034 B 方案)

`packages/{app,ui}`(上游 opencode 前端)**不再冻结**,改为**跟随一个显式上游 pin + alpha 前端补丁序列**,
以持续白嫖上游前端更新,同时保留 alpha 的前端定制。取代 ADR-020 的冻结机制。

## 载体
- **`frontend-pin.lock`** — 被跟随的上游 SHA(`pin=<sha>`)。`packages/{app,ui}` 恒等于 pin 的上游态 +
  下述补丁。
- **`alpha-patches/alpha-frontend.patch`** — alpha 前端定制相对 pin 的**完整 delta**(单文件,**唯一 SOT**)。
  内容 = AppSurfaces typed surface seam(ADR-027)+ Settings/Recovery/Permission seam + `./surface/session`
  窄导出等。**改前端 seam = 改 `packages/{app,ui}` 后重生此补丁**(见下),不要手改本文件。

## 日常 sync(自动,只进引擎)
`sync-upstream.yml` 每次 sync 合并上游 dev 后,`apply_alpha_frontend_delta` 把 `packages/{app,ui}` 还原为
`pin + alpha-frontend.patch`。补丁 3-way apply 失败(pin 与补丁漂移)→ loud-fail 阻断 sync,提示跑月更 bump。

## 月更 bump(升 pin,人门禁)—— 流程
每月一次(或需要上游新前端修复时手动)把 pin 升到近期上游:

```sh
cd packages/ui-mac            # worktree 根按需
NEWPIN=$(git rev-parse upstream/dev)   # 或选一个近期稳定上游 SHA

# 1) 取新上游前端 + 贴 alpha 补丁(3-way)
git checkout "$NEWPIN" -- packages/app packages/ui
git apply --3way --whitespace=nowarn frontend/alpha-patches/alpha-frontend.patch
#   ↑ 若冲突(尤其 app.tsx 高 churn 枢纽):手动/codex 把 alpha 的叶注入 seam(createSessionRoute /
#     createDraftRoute / AppSurfaces)重架到上游新路由;dialog/settings/permission seam 同理。

# 2) 重钉 L1 变换 + 锚点(上游改名/搬文件时)
#    - packages/ui-mac/scripts/{patch-upstream,brand-i18n}.ts 的 loud-fail 目标随上游 build 失败时重钉;
#    - 锚点契约:cd packages/ui-mac && bun scripts/gen-upstream-anchors.ts;失配测试逐条判真断/陈旧快照。

# 3) 全门禁(真环境)
bun install
bun run --cwd packages/ui-mac typecheck   # 0 错
bun run --cwd packages/ext typecheck       # 0 错
(cd packages/ui-mac && bun test src)       # 0 fail
(cd packages/ui-mac && bun run build)       # electron-vite full build 通过

# 4) 更新 pin + 重生 SOT 补丁(相对新 pin)
echo "pin=$NEWPIN # $(date +%F)" > frontend/frontend-pin.lock
git diff "$NEWPIN" HEAD -- packages/app packages/ui > frontend/alpha-patches/alpha-frontend.patch
#   round-trip 自检:git checkout $NEWPIN -- app ui && git apply --3way alpha-frontend.patch,应与 HEAD 零 diff

# 5) 开 PR,owner 真机视觉复验(布局切换 / dialog 焦点 / composer / timeline / permission)后合。
```

**退化模式安全**:bump PR 不合 = 暂时停在上一个 pin(等价于旧冻结态),日常 sync 与产品 PR 不受影响。

## 为什么这么设计
见 [ADR-034](../.claude/rules/adrs/ADR-034-frontend-rolling-pin.md)(supersede ADR-020 冻结,反转 ADR-016
「放弃白嫖上游前端」前提)。更干净的终局(C:app/ui 零 delta、定制全走 ui-mac 组合)可在 B 稳定后滑行过去。
