---
title: REQ-005 re-anchor + residual packaged evidence index/harness
kind: verification-plan
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-22
review_after: 2027-01-16
---

# REQ-005 · re-anchor + residual packaged evidence index (harness)

> 本档是 [alpha-code#214](https://github.com/jinjunnn/alpha-code/issues/214) 残项
> 取证的**执行索引 + 采集 harness**。上游一次性静态基线是
> [`docs/audits/2026-07-12-req005-legacy-baseline.md`](../audits/2026-07-12-req005-legacy-baseline.md)
> (下称「基线」),其 §1 矩阵 / §3 依赖清单 / §3.5 接缝结论是本次取证的判定口径来源。
> 本档只补基线 §5「未取证残项」的 ~40 shot,不重做 §1/§3 的静态核对。

## 0. Scope re-check(消费者仍在、残项已确认在范围内)

- **旧消费者 REQ-087 / [#180] 已关闭**,已消费基线 §1/§3(依赖拓扑清单交付物①)——
  基线头注 :10-12 记录的 spike 用途**已履约作废**,不再是本次取证的驱动方。
- **owner 已确认残项仍需要**(2026-07-22):~40-shot packaged 视觉证据的**现行消费者 =
  REQ-088 结构接管**(基线把 T3/T4 明确归 REQ-088,§1.1 表 + §6 缺口 1/2;结构接管前需要
  真机基线快照界定「接管前观感」)。DECIDE(残项是否在范围内?)= **YES,已裁决**,记于本档
  与子票,不再复议。
- 范围不变(基线 :13-14):只建 characterization/视觉基线,**不新增 selector/observer/Portal**,
  不代表页面/路由/运行时所有权完成。

## 1. Live-path re-anchor(frozen-base-2 → rolling pin 849c2598)

基线把每一条 file:line 钉死在 **frozen-freeze-base-2**(`42f14c6b…`,ADR-020)。该冻结模型
**已死**:ADR-034 / PR#474(commit `107e4737`)把 `packages/{app,ui}` 从冻结钉 tag 迁到
**滚动 pin+补丁**,SOT = `frontend/frontend-pin.lock`(实测 `pin=849c2598 # 2026-07-21`)。
因此基线的 file:line 是**冻结期快照,不能直接当今日真值**。

**取证前必做(live-path 诚实门,REQ-097 教训):**

1. 在**当前工作树(pin 849c2598)** 跑锚点契约测试,而非冻结基线:
   ```
   bun test packages/ui-mac/src/renderer/alpha-ui/upstream-anchors.test.ts
   ```
   三断言必须全绿(清单新鲜 / alive 全渲染 / knownDead 保持死)。
2. **已勘破的锚集漂移(必须写进取证记录):** 基线 §0 记 `alive=176 / knownDead=6`;
   本档核对当前 `upstream-anchors.json` 实测 **`alive=172 / knownDead=4`**
   (knownDead 现仅 `action:allow` / `action:deny` / `slot:button` / `slot:icon-button`)。
   基线 §0.1 记为「假死」的 `component:session-composer` / `component:session-new-composer`
   **已从清单整体消失——既不在 alive 也不在 knownDead**(json 内零出现,实测)。机制**不是
   「迁回 alive」**:composer 接管的选择器已改写为
   `[data-component="session-prompt-dock"] [data-component="prompt-input-v2"]`
   (`composer-takeover.tsx:20`),不再引用 `session-composer/session-new-composer`;没有任何
   alpha 资产再引用这两个锚,`gen-upstream-anchors.ts` 便不再把它们纳入 manifest(锚点从清单
   掉出 = takeover selector 改动的下游,非成员身份迁移)。**基线 §0.1 的 knownDead 勘误结论就地
   作废**(其前提锚已不在清单),取证时以测试绿 + 实时 DOM 为准。
3. 逐面开拍前,先 `document.querySelector` 复验该面的关键锚点在**运行中 renderer** 命中
   (verified-from-code 的锚点 ≠ 今日 live DOM;只认实跑命中的才开快门)。

**本档已从代码核实 vs 必须实跑复验的分界(诚实声明):**
- 已从代码核实:pin=849c2598;anchor test 文件与生成脚本在位;alive/knownDead 计数如上。
- 必须实跑复验(取证时):每一条 §1 矩阵锚点在 pin 849c2598 运行态 DOM 的真实命中位置
  (基线 file:line 仅作起点线索,不作真值)。

## 2. 残项采集 harness(基线 §5「未取证」四项 → 精确触发)

判定口径沿用基线 §1 矩阵的 D/T/P 单元格 ID。每 shot 命名 `NN-<face>-<theme>.png`。

### 2.1 终端 PTY 面板 T2–T4(基线 §1.1)
基线 §5 残因:上次会话 Shell **走工具通道**,PTY 面板未开。触发:
- 开**真 PTY 面板**(不是 tool-channel shell):`terminal.toggle` keybind
  (`packages/app/src/components/terminal.tsx:20-21`)或面板新建按钮开
  `id="terminal-panel"`(`terminal-panel.tsx` 外框,基线 T3 记 :198-208 无 data 钩子——
  live 复验)。面板挂 `[data-component=terminal]` 外框(基线 T1,`review.css:311-314`)。
- T2:ghostty canvas 内核观感(接受的引擎边界,拍存档界定「未换肤内核」)。
- T3:面板 chrome(tab 条/新建关闭按钮/面板头)——缺口,拍存档给 REQ-088。
- T4:header bar(上游不渲染 DOM)——拍「无 header」现状。
- 真跑一条 PTY 命令产生回滚缓冲(验证 buffer 序列化面,基线 §3.3 :236-254 不在视觉范围,
  只拍面板观感)。

### 2.2 权限确认面 + question dock(基线 §1.3 P1–P5 已被 REQ-090 收编)

**live-path 更正(基线 §1.3 大前提翻转):** 基线 §1.3 的 **P1–P5 全部钉在上游 permission dock**
(`dock-prompt.tsx` / `session-permission-dock.tsx` / `session-composer-region.tsx` 内联 dock)。
在 pin 849c2598 上**这条链已整体死亡**(本档已从代码核实):
`packages/ui/src/components/dock-prompt.tsx` 与
`packages/app/src/pages/session/composer/session-permission-dock.tsx` **均不存在**;
`session-composer-region.tsx` **零 permission 引用**;`composer-reskin.css` **无
`data-kind=permission` 作用域**;`session-composer-state.ts` 的 `blocked()` **只看
`questionRequest()`**(:33-36,已无 `permissionRequest`)。基线 P1–P5「上游卡壳/图标/主按钮换肤」
的判定**已作废**,不存在可拍的上游权限 dock。

**权限确认现由 REQ-090 / #433 收编为 alpha 自有对话框(PermissionV2,commit `c87b7b81` PR#450):**
运行态权限确认面 = `PermissionWatcher`(SSE `asked/replied` delta → 重建请求栈,
`packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx`)驱动的 `PermissionDialog`
(`packages/ui-mac/src/renderer/alpha-ui/PermissionDialog.tsx` + `permission-dialog.css`),数据面走
SDK v2 `PermissionV2Request/PermissionV2Decision`。这是一整套 **alpha-owned 组件,不是上游 dock 换肤**。

**残项处置(owner scope re-check — 见 residual):** 该确认面的所有权在 REQ-090。REQ-005 证据索引
是否仍要为它出 packaged 视觉证据、还是该证据归 REQ-090 自身验证,**留 owner 裁决,本档不擅自认领**。
若 owner 判归 REQ-005,则按下列真面触发(捕 **alpha PermissionDialog**,非上游 dock):
- **不种预授权 grant**:授权/autoAccept 在 `packages/app/src/context/permission.tsx`(live provider
  已重写为多 server 形态)持久于
  `Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"])`(`permission.tsx:192`);
  autoAccept 键 `<b64(dir)>/<sessionID>` 与目录通配 `<b64(dir)>/*`
  (`packages/app/src/context/permission-auto-respond.ts:3-16`)。在**隔离根**不种授权(或用新目录),
  使 `permission.asked` 到达 → `PermissionWatcher` 入栈 → `PermissionDialog` 渲染。
- 驱一条需审批工具(如写 workspace 外文件 / 未预授权命令)触发 `permission.asked`,拍 alpha
  对话框观感(卡壳/图标/「允许一次·拒绝·总是允许」按钮 = alpha 自有 `Button`+`permission-dialog.css`)。

**P6 question dock(仍活,归 REQ-088 缺口):** question 卡是**当前唯一仍存活的 DockPrompt 面**。
锚点 `[data-component="session-question-dock"]`
(`packages/app/src/pages/session/composer/session-question-dock.tsx:454`),其内 `DockPrompt`
**import 自 `@opencode-ai/session-ui`**(`session-question-dock.tsx:5`,`kind="question"`)——
注意这**翻转了基线 §0 的「app 一律 import `@opencode-ai/ui`」前提**(勘误落审计 §7.2)。
alpha CSS 对 question 无任何作用域规则(基线 P6 缺口成立)。触发:驱一条模型**反问** →
`questionRequest()`(`session-composer-state.ts:29-30`)非空 → 拍未换肤现状给 REQ-088。

### 2.3 深色主题全组 + 40 timeline 构件深/浅回归(基线 §5 第 3 项)
- 深色主题跑**基线 §1 全矩阵 D1–D8 / T1–T4** 一遍(浅色已在
  `docs/audits/2026-07-12-s41-visual/` 有 D1/D3/D4/composer 部分)。**P 组已重定义**:上游
  P1–P5 dock 已死(§2.2),深色只拍 alpha `PermissionDialog`(若 owner 判归 REQ-005)+ P6
  question dock 未换肤现状,不再按基线 P1–P6 逐格。
- 40 timeline 构件(基线 §2:入口 + `timeline/{user,assistant,tools,structure,review,misc}.css`
  约 40 组锚)深/浅各一遍,拍 token 换肤未回归(单 indigo accent / `--a-*` only)。
- 主题切换入口被 `settings-reskin.css:1-7` 锁——用 `window.api` / 设置态直切,不点隐藏入口。

### 2.4 packaged 真机 ship:mac(基线 §5 第 4 项 / §4 dev-plan 第 3 项)
- **不用冻结基 CDP dev**;用 packaged-macOS-RC 方法
  ([`docs/verification/2026-07-17-packaged-macos-rc-smoke.md`](2026-07-17-packaged-macos-rc-smoke.md)):
  `OPENCODE_CHANNEL=prod bun run build && package:mac`,直接跑 `dist/mac-arm64/alpha-code.app`
  (**不 install:local**),`OPENCODE_TEST_ONBOARDING=1` 全根改道隔离,CDP
  `--remote-debugging-port` 驱 renderer `window.api.*` 做真 IPC。
- 隔离根里**不种预授权 grant**(见 2.2)以令 alpha `PermissionDialog` 真渲染(若 owner 判该面归
  REQ-005);PRO 登录态驱真会话。

## 3. 证据落点 + per-shot → matrix-cell 映射

- 快照归档:`docs/verification/2026-07-22-req005-shots/`(浅/深分子目录)。
- 每 shot 一行,填下表(执行时补 `path` 列),cell 引基线 §1 的 D/T/P ID:

| shot | matrix cell(基线) | theme | packaged? | 备注 |
|---|---|---|---|---|
| NN-terminal-pty | T1/T2/T3/T4 | light+dark | ship:mac | 真 PTY,非工具通道 |
| NN-permission-dialog | (P1–P5 → REQ-090 收编) | light+dark | ship:mac | alpha `PermissionDialog`,非上游 dock;**归属待 owner** |
| NN-question-dock | P6 | light+dark | ship:mac | question 卡未换肤;`DockPrompt`@`session-ui` |
| NN-timeline-set | D1–D8 + §2 40 组 | light+dark | ship:mac | token 回归 |

- 索引结论(通过/缺口)回写本档执行小节 + Issue #214 逐条勾;**不进 requirements
  (目录已删,见 §5)**。

## 4. 接缝安全结论(class-first,取证中必须保持,勿逐实例漂移)

沿用基线 §3.5,取证不得引入任何违反下列**类**的操作:

- **DOM-anchor 耦合类**:只读锚点、隐藏控件点击(如 `[aria-controls="review-panel"]`,
  基线 §1.2)是既有现状;取证**不新增**任何 selector/observer/Portal(非目标)。
- **persistence-key 类**:`layout.v6` 单 blob / terminal buffer(workspace 级
  `opencode.workspace.*.dat`)/ permission autoAccept——**无跨会话/跨 workspace 串味**;
  取证在隔离根跑,勿污染真实 `~/.alpha`(packaged-RC 已证隔离,见 RC smoke §环境事实)。
- **engine-boundary 类**:ghostty PTY / @pierre Shadow DOM / shiki token 一律**经 props/SDK
  适配,永不走 DOM**;取证只拍引擎内核**观感**,不试图从外部 CSS 穿透内核
  (基线 T2/D5/D8 = 接受的引擎边界)。

## 5. 非目标(取证不做)

- 不新增 selector / observer / Portal / inject。
- 不做 full takeover / 页面·路由·运行时所有权(那是 REQ-088)。
- 不建本地 sprint / 状态镜像;交付状态只在 Issue #214 + Project。
- 不回写 `docs/requirements/`——该目录 **已删**(`d2f9cd08`,docs-governance v3);
  结论只落 `docs/audits/` + `docs/verification/`。

## 6. 与现状/上一稿的关系

- **上一稿** = 2026-07-12 基线(冻结期一次性静态核对 + 浅色部分取证)。本档**不改写**它,
  只补其 §5 残项;并就地声明基线三处已过期前提:①file:line 钉 frozen-base-2 →
  今日 rolling pin 849c2598(§1);②基线 §0.1 knownDead 勘误——两锚已从清单整体消失(非「迁回
  alive」),因 takeover selector 改动不再被引用(§1 第 2 点);③基线 §1.3 权限 dock 链已死,
  权限确认改由 REQ-090 PermissionV2 alpha 对话框承担(§2.2)。
- **与现行代码的关系**:pin=849c2598 为今日真值;anchor test 是取证前的 live-path 闸。
- **消费者变更**:REQ-087/#180(旧驱动)已关闭;现行消费者 = REQ-088 结构接管(§0)。
