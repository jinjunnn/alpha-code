---
id: ADR-034
title: 前端滚动 pin(B 方案):packages/{app,ui} 从「冻结」迁到「pin + 补丁序列」,持续白嫖上游前端
status: accepted
date: 2026-07-21
related: [ADR-016, ADR-020, ADR-027, ADR-029]
supersedes: ADR-020
---

> **状态:accepted(owner 2026-07-21 拍板 B-月更)。** 本 ADR **supersede ADR-020(前端冻结)**,
> 并反转 ADR-016「放弃白嫖上游前端」的前提。起因:冻结机制每次 sync 都丢弃上游前端更新、并擦掉
> alpha 加进冻结包的 seam(已擦 #451/#452),与 owner「持续白嫖上游 opencode 前端」的诉求正面冲突。

## 背景(前提再评估)

1. **ADR-016/020 的前提已失效**:ADR-016(2026-06-24)判「全面接管后上游前端更新近乎纯负担」、
   ADR-020(2026-07-03)据 REQ-013「要免疫上游 churn」把 `packages/{app,ui}` 冻结钉在
   `frontend-freeze-base-N` tag。但 **owner 2026-07-21 明确要持续跟随上游前端**,且实测 alpha 只用
   上游的引擎型叶(session/timeline/composer 内核),上游 3 周内对这些叶有 39+ 个修复;冻结让 alpha
   会话页卡在旧版、错过全部上游修复,且上游已定 **2026-09-14 日落旧界面**——冻结不是省成本,是让迁移
   悬崖每周变高。
2. **冻结机制自伤**:`sync-upstream.yml` 的 `restore_frozen_frontend` 每次 sync 后 `rm -rf app ui +
   checkout base-3`,擦掉 base-3 之后加入的 alpha seam(#451/#452 已被擦,typecheck 红全仓)。
   冻结契约假设「seam 变更罕见」,实测每周一次——这是「打地鼠」的结构性根因。
3. **alpha 的前端定制面很小、且已抽成补丁**:全部 alpha 对 `packages/{app,ui}` 的编辑 = 4 个提交
   (AppSurfaces seam + #450/#451/#452),约 25 文件;与上游 churn 少重叠,3-way 可吸收大半。

## 决策

**packages/{app,ui} 从「冻结钉 tag」迁到「pin + 补丁序列」(B 方案,月更节奏)。**

### 1. 载体
- `frontend/frontend-pin.lock` 记录被跟随的上游 SHA(`pin=<sha>`)。app/ui **恒等于** pin 的上游态
  + alpha 前端 SOT 补丁 `frontend/alpha-patches/alpha-frontend.patch`(单文件,alpha 前端定制相对
  pin 的完整 delta,是**唯一 SOT**——改 seam = 改补丁 + 重生)。
- **擦除 bug 从机制上消失**:sync 还原的目标从「手铸 tag」换成「pin + 补丁」,而产品 PR 改 seam 改的
  就是补丁(还原源),不存在「加进冻结包又被擦」的窗口。

### 2. 日常 sync(只进引擎,app/ui 恒定在 pin)
`sync-upstream.yml` 的 `restore_frozen_frontend` → `apply_alpha_frontend_delta`:每次 sync 合并 dev
后,`rm -rf app ui; git checkout $pin -- app ui; git apply --3way alpha-frontend.patch`。补丁 3-way
apply 失败 = pin/补丁漂移 → loud-fail 阻断 sync。seam marker(AppSurfaces / `./surface/session`)校验保留。

### 3. 月更 bump(前端前进,人门禁)
每月(或手动触发)一个 bump:`pin := upstream@HEAD`;checkout 新 pin 的 app/ui + 3-way apply 补丁 +
**重生补丁**(相对新 pin);全门禁(install / typecheck / build / ui-mac test / 锚点契约 / L1 变换
loud-fail);开 PR 供人视觉抽查后合。冲突(尤其 app.tsx 高 churn 枢纽)在 bump PR 里解,不污染日常 sync
与产品 PR。退化模式安全:bump PR 不合 = 暂时停在上一个 pin(即旧冻结态的等价物)。助手见
`frontend/README.md`。

### 4. 守卫映射(北极星不变)
`packages/{app,ui}` 本就不在 `UPSTREAM_PATHS`(ADR-020 已移出),北极星守卫零改。前端锚点 tripwire
(REQ-012,sync-upstream.yml 内)保留——它在上游改名/删锚点时 warning 要求人工视觉复验。

## 后果
- ✅ **持续白嫖上游前端**:pin 月更跟随近期上游,alpha 会话页/timeline/composer 拿到上游修复;9/14
  日落前迁移悬崖不再每周变高。
- ✅ **擦除 bug 消失、产品 PR 不再红**:app/ui 恒 = pin+补丁,seam 不被擦;typecheck 稳定绿。
- ✅ **维护成本从「散布式打地鼠」变「每月一个可预期时间盒」**:日常 sync 与产品 PR 永不因前端红;红只
  出现在月更 bump PR(高声、隔离)。
- ⚠️ **月更 bump 的那次 app.tsx 高 churn 枢纽合并需人/codex 判断**(seam 重架到新上游路由)+ owner 真机
  视觉复验(布局/dialog/permission);补丁 rebase 估 1~3 次/月。
- ⚠️ **pin 与引擎的漂移**:日常 sync 进引擎、app/ui 停在 pin,月内可能漂移;月更 bump 收敛。若引擎 API
  破坏 app/ui@pin 的 typecheck,PR 门禁会红(需加急 bump)。
- 🔭 后续:C 方案(组合化终局,app/ui 零 delta、定制全走 ui-mac 组合/L1 变换)是更干净的终局,可在 B 稳定
  后滑行过去(第一步可零成本把 AppSurfaces seam 作 PR 提给上游)。

## 迁移落地(本批)
- Phase 1a:恢复被擦 seam + 建补丁 SOT(#466 已合 alpha,typecheck 转绿)。
- Phase 1b:app/ui 升到 pin `849c2598`(+44k/-27k 上游前端)+ seam 重架 + ui-mac 适配 + 锚点/L1 变换
  重钉;真环境 typecheck 0 / ui-mac 2439 test 0 fail / electron-vite full build 通过。
- Phase 2:`apply_alpha_frontend_delta` 机制 + pin.lock + SOT(本 PR)。
- Phase 3:日常 sync cron 重开(#465 曾暂停止血,机制已 B-safe)。
