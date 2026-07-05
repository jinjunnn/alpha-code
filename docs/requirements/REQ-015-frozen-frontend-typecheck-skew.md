---
id: REQ-015
title: 冻结前端 typecheck 偏斜:session-ui(546 后新增)依赖新版 ui API 与冻结 ui 不兼容
type: debt
priority: P2
status: shipped
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
---

## 背景(为什么)
ADR-020 把 `packages/{app,ui}` 冻结在 `frontend-freeze-base`(546 前)。但 546-sync **新增**了
`packages/session-ui`(冻结基点不存在),它引用新版 ui 的组件 props(`TextInputV2Props.showClearButton`、
`ScrollViewProps.thumbVisibility`),而冻结 ui 无这些 → `session-ui#typecheck` 失败。

**影响面窄**:session-ui 只被上游叶子包 `enterprise`/`storybook` 消费,**alpha 的 ui-mac/ext/app 都不用、不 build、不 ship**(enterprise 且属 NON_GOALS#6)。故:
- **CI 绿**:`alpha-ci` typecheck 只查 `packages/{ext,ui-mac}`,不含 session-ui → 合并不受阻(PR #46–51 全绿);
- **只卡本地 pre-push**:上游 `.husky/pre-push` 跑全量 `bun turbo typecheck`(含 session-ui)→ 本地 `git push` 红。turbo 缓存曾一直掩盖(replay 冻结前的 pass),某次 ship 构建使缓存失效才暴露。

## 目标(做什么)
让冻结世界的 workspace typecheck 一致,消除本地 pre-push 的 session-ui 红灯,且不破坏:
① 引擎耦合(enterprise/storybook import 当前 `core`/`sdk`,不能盲目冻回 546 前);② 北极星(session-ui 不在守卫集,但方案不得改上游 `.husky`/`turbo.json`)。

## 方案菜单(待拍板)
1. **移除 3 个未 ship 上游叶子前端包**(session-ui + enterprise + storybook):alpha 不 ship、NON_GOALS 排除;sync restore 追加再移除。代价=删上游包、每次 sync 要再删。
2. **session-ui 打补丁到冻结 ui 兼容**(去掉 2 处新 props 用法):最小改面,但改上游 session-ui 源码,每 sync 复发。
3. **接受本地 pre-push 红、以 `--no-verify` + CI 为权威门**:零改动,但每次本地 push 要 `--no-verify`,易掩盖真问题。
4. **把 ADR-020 冻结范围扩到完整上游前端叶子集**并处理引擎耦合(最正,最重)。

**推荐**:先 spike 方案 1 的引擎耦合影响(enterprise/storybook 冻回 vs 当前 core/sdk);若干净则 1,否则 3 作临时 + 2 收敛。

## 拍板与实施(2026-07-05,S17 T2)

**四方案结构性淘汰/坍缩,采纳档外方案 5**(完整淘汰逻辑落 [ADR-020 修订](../../.claude/rules/adrs/ADR-020-frontend-freeze.md)):
- 方案1/2 触 ADR-020 §3 红线——session-ui 在引擎零改动集内,删/改 = DMR diff = 北极星守卫红(spike 补证:enterprise/storybook **同时**依赖 session-ui+ui,方案1 连坐三包且每 sync 复发);
- 方案4 对 session-ui 无解(冻结基点不存在它,「冻结」= 删除 → 坍缩回方案1);
- 方案3 被方案5 严格支配(方案5 最坏退化态 = 方案3)。

**方案 5 = 本地 push 门 rewire 到 alpha 自有 `.githooks`**(上游零改):
1. `.githooks/pre-push`(2026-07-03 已存在的可选设施)转**默认**——执行 `scripts/alpha-check.sh`(与 alpha-ci 1:1,含北极星守卫);
2. **根因对策**:husky `prepare` 每次 `bun install` 后把 `core.hooksPath` 重置回 `.husky/_`(=「配置过又失效」的真因)→ `alpha-check.sh` 开头幂等自愈重挂(逃生 `ALPHA_HOOKS_DISABLE=1`);残余窗口的退化态 = 旧状(撞上游红门),永不更糟;
3. `docs/CI.md` §6 由「可选」改「默认开启」并写明根因;
4. 全量 turbo typecheck 的 session-ui 红 = **接受的已知偏斜**(上游叶子,alpha 不 ship;re-freeze 体检时复查)。

## 非目标
- 不改上游 `.husky/pre-push`、`turbo.json`(会破北极星或 sync 冲突)。

## 关联
[[ADR-020]](冻结,本缺口的来源)、REQ-013(脱耦终局)、NON_GOALS#6(enterprise 排除)。

## 验证记录
- 2026-07-03 发现:prod ship 构建使 turbo 缓存失效 → `session-ui#typecheck` 暴露(showClearButton/thumbVisibility)。docs PR #51 经 `--no-verify` 推(CI 权威门绿)。
