---
id: ADR-027
title: Alpha Product Kernel:typed surface seam 进入冻结前端 + frontend-freeze-base-2 新基点(L3 re-freeze,REQ-084 实施门)
status: accepted
date: 2026-07-12
related: [ADR-016, ADR-020, ADR-029, REQ-084, REQ-085, REQ-086, REQ-090]
---

## 背景

1. 产品所有权专项(REQ-084~107)要求 Alpha 拥有用户可见叶页面,而 [[ADR-016]] 的接管
   目标当前只能靠 route-aware children / Portal / DOM takeover 叠在上游页面之上——
   双页面生命周期,无法证明 upstream 页面无隐藏副作用(REQ-085 背景实证:AlphaHome
   Portal 覆盖)。
2. `packages/app` 被 [[ADR-020]] 冻结于 tag `frontend-freeze-base`,每日 sync 由
   `restore_frozen_frontend` 步骤还原;任何未进入冻结基点的 seam 修改都会在下一次
   sync 中蒸发。
3. [[ADR-029]] 主权阶梯已裁定该诉求的两种合法形态:新冻结基点(L3 既有 re-freeze
   通道)或恢复后机械 seam patch(新增一台 L2 机器),并预倾向前者(§6,2026-07-12
   评审拍板已记入 REQ-084 档与 Issue #199)。

## 决策

1. **建立 Product Kernel 最小 seam**:`AppInterface` 新增可选 `surfaces` prop
   (`home` / `newSession` / `session` 三个叶 surface),每项为窄
   `MaybePreloadableComponent` 契约(`Component & { preload?(): void }`)。
   - 未提供 override 时严格使用 upstream 默认页面(lazy/preload 行为等同);
   - surface 在 route tree 首次挂载前一次性解析,同一 renderer 生命周期内不热换
     Provider tree(换 surface 必须 reload);
   - 只替换最内层叶页面;`SelectedServerLayout` / `DraftServerLayout` /
     `DirectoryDataProvider` / `SessionProviders` / `DraftProviders` 与 `Layout`
     保持默认生命周期,不导出私有 context;
   - `@opencode-ai/app` 只新增导出窄类型 `AppSurfaces` / `MaybePreloadableComponent`,
     不新增对 `context/*` 的批量 public export。
2. **冻结策略 = 新冻结基点 `frontend-freeze-base-2`(L3)**,采纳 ADR-029 §6 预倾向:
   - 含中性 seam 的 `packages/{app,ui}` 状态铸为新 tag `frontend-freeze-base-2`,
     走 ADR-020 §5 既有 re-freeze 通道,机制零新增;
   - 否决「恢复后机械 seam patch」:它新增一个持续维护的 L2 补丁面,与 ADR-020
     摆脱逐次跟随的初衷相悖;
   - `sync-upstream.yml` 的 `restore_frozen_frontend` 改指 `frontend-freeze-base-2`,
     并在还原后**校验 seam 存活**(marker 检查);校验失败即 loud-fail 阻断,禁止
     warning 后继续;
   - seam 契约测试与 seam 同驻 `packages/app/src`,随冻结基点一起被还原,保证
     restore 后测试仍在且可跑。
3. **surface 选择权在 Alpha 侧**:发布状态(`alpha | legacy | auto-fallback`)由
   ui-mac main 进程可信配置决定,在 renderer route tree 挂载前传入;packages/app
   seam 保持策略中立,不读任何 alpha 配置。致命 surface 错误的记录与 reload 回退
   由 Alpha 自有 boundary 承担,不吞发送/权限/数据一致性错误。
4. **修订 ADR-016/020**:ADR-016 的接管路径新增「typed surface seam(本 ADR)」
   为正式通道;ADR-020 §1 冻结基点更新为 `frontend-freeze-base-2`,§4 纪律不变
   (app/ui 仍只读,唯一写通道仍是受控 re-freeze)。
5. **回退方案**:每个 surface 独立回退——flag 置 `legacy` 后 reload 即回上游页面,
   URL 与持久化状态不变;最坏整体回退 = tag 退回 `frontend-freeze-base`(seam 蒸发,
   Alpha 页面自动回到 Portal 时代入口,不破坏数据)。

## 后果

- ✅ Alpha 首次获得叶页面真所有权通道;REQ-085/086/087/090 全部经此 seam 激活,
  不再各自发明接管机制。
- ✅ 冲突数=0 语义不变:app/ui 不在同步集,seam 随基点还原,机制上不可能与上游冲突。
- ⚠️ L3 单向门代价延续(ADR-020 已实证):seam 所在前端范围继续放弃上游白嫖;
  未来吸收上游前端改进时,re-freeze 体检需额外验证 seam 兼容(ADR-020 §5 ③ 的
  锚点契约测试覆盖)。
- ⚠️ 每次 re-freeze 必须重铸含 seam 的新基点(seam 是新基点的一部分,不是补丁),
  操作步骤已并入 ADR-020 §5。
- 🔭 待办:REQ-091(AlphaRuntime parity、移除 AppInterface)仍 parked;seam 是
  中间态,不是终局。

## 修订(2026-07-13,REQ-088 C1 —— 冻结基点轮换 frontend-freeze-base-3:`./surface/session` 窄导出)

REQ-087 spike(`docs/spikes/2026-07-12-req087-legacy-session-adapter.md` §4/§8 C1)裁定:
LegacySessionAdapter 需要消费上游 session 叶,而合法窄通道不存在(exports map 无 pages 子路径,
spike 期以「受限 deep import + 锚点收敛」过渡)。按 ADR-029 L3 既有 re-freeze 通道
(ADR-020 §5,机制零新增)再转一次基点,通道合法化:

1. **新基点** = tag `frontend-freeze-base-3`:内容为 `frontend-freeze-base-2` 的
   `packages/{app,ui}` + `@opencode-ai/app` package.json exports 新增一条
   `"./surface/session": "./src/pages/session.tsx"`。除该行外与 base-2 逐字节一致——
   本次 re-freeze 不吸收任何上游前端 churn,不改任何源码文件。
2. **窄面逐 export 评审(L3 逐案纪律)**:`./surface/session` 指向的模块仅有
   `default`(session Page 组件)一个导出——留;不设 `./surface/*` 通配,不新增
   `./pages/*`/`./context/*` 子路径,不走 index.ts 命名导出(破坏 lazy 分包,spike §4
   已否决)。窄面由三层机械守卫锁死:`surface-seam-contract.test.ts`(surface 子路径
   集合 === [`./surface/session`] + session 叶单 default 导出)、
   `req087-characterization.test.ts` §6(exports map 集合相等 + 唯一消费点)、
   `scripts/verify-freeze-restore.sh`(restore 后锚点核验)。
3. **消费面收敛**:窄导出全仓唯一消费点 = `session-spike-host.tsx`(拟议
   LegacySessionAdapter 边界);spike 期相对路径 deep import 同步废除,锚点测试红线
   防散射(REQ-087 C3)。
4. **还原步改指新 tag**:`sync-upstream.yml` `restore_frozen_frontend` 检出
   `frontend-freeze-base-3`,marker 校验在既有 `AppSurfaces` 之外新增
   `./surface/session` 导出行;任一 marker 缺失即 loud-fail 阻断整个 sync。
5. **回退**:tag 退回 `frontend-freeze-base-2`(窄导出蒸发,消费点 typecheck TS2307 +
   锚点测试先红,不会静默漂移);`frontend-freeze-base`/`frontend-freeze-base-2` 均保留不动。
6. 本修订与 [[ADR-020]] 同日修订(§1 基点更新为 base-3)配套;`SURFACE_RELEASE_STATES.session`
   仍为 `legacy`,REQ-088 主实现(T2+)在 C2–C4 全绿前不得升出默认。

## 修订(2026-07-24,REQ-125 #554 —— 增补 `./surface/terminal` 窄导出)

REQ-125 会话页 seam 基线(`docs/design/2026-07-24-session-seam-baseline.md` §② 白名单
口径:确缺能力才补窄 export;§④ C3-term 终端面板条目)裁定:右栏终端面板复用上游终端
引擎 —— workspace 级 PTY 页签状态(`@/context/terminal` 的 `useTerminal`)+ Ghostty 嵌入
(`@/components/terminal` 的 `Terminal`)—— 而两者今日均不在 `@opencode-ai/app` 公开面
(#550 勘破)。按 L3 逐案纪律增补第二条 surface 子路径;载体走 [[ADR-034]] pin+patch
通道(SOT = `frontend/alpha-patches/alpha-frontend.patch`,冻结 tag 机制已被 ADR-034
取代,本修订不再铸基点):

1. **新增 export**:`"./surface/terminal": "./src/surface/terminal.ts"`。指向的模块为纯
   re-export,恰好三个符号:`useTerminal`、`Terminal`、`type LocalPTY`;不 re-export 未用
   符号,不设 `./surface/*` 通配,不新增 `pages`/`context` 子路径。
2. **消费面收敛**:窄导出全仓唯一消费点 = ui-mac
   `alpha-ui/session-rail/terminal/terminal-engine-adapter.tsx`(把引擎收敛成
   `AlphaTerminalEngineChannel` typed seam,铸造时盖会话三元身份,消费侧经
   `live.accepts` fail-closed 把闸)。机械守卫:`surface-seam-contract.test.ts`
   (exports map 集合断言更新为 `["./surface/session","./surface/terminal"]` +
   re-export 模块窄面逐行断言)、`terminal-engine-adapter.test.ts`(renderer 全扫,
   引擎 import 仅此一处)。
3. **回退**:从 patch 序列移除该 export 行与 re-export 文件即蒸发;消费点 typecheck
   TS2307 + seam 契约测试先红,不会静默漂移。

## 修订(2026-07-24,REQ-125 #574 —— surface 静态标记 `ownsTitlebar`:session 路由单一顶栏)

Owner 真机验收发现 alpha 会话页 46px 顶栏之上仍叠着上游窗口 Titlebar(双层顶栏,违反已批稿
「单一顶栏」)。勘破:上游 Titlebar 由 `NewLayout`(`pages/layout-new.tsx`)在 **router root**
渲染、跨全部路由常驻,不在任何叶路由内 —— 叶挂载点上移绕不过它(且会丢失 `SessionProviders`/
`TerminalProvider` 对 #554 终端适配器的包裹)。按最简条件经 [[ADR-034]] pin+patch 通道扩一档
seam 语义:

1. **seam 形态**:`MaybePreloadableComponent` 增可选静态字段 `ownsTitlebar?: boolean`。
   session surface 组件声明 `ownsTitlebar = true` = 该 surface 自带会话页唯一顶栏(含窗口
   拖拽区);`AppInterface` 随 surfaces 一次性解析(严格 `=== true`),经 `NewAppLayout`
   传入 `NewLayout`,后者仅在「标记 ∧ `layout.route().type === "session"`」时跳过上游
   Titlebar。标记缺席(上游默认叶 / 未注入模式)与其余路由(home/draft)= 上游 Titlebar
   原样,fail-closed 零回归。
2. **消费面**:唯一声明点 = ui-mac `alpha-session-workspace.tsx` 的
   `alphaSessionWorkspaceSurface`(工作区顶栏同步承接 `-webkit-app-region: drag`,交互件
   no-drag;侧栏折叠态给 macOS 红绿灯与浮动工具簇让位 —— 见 `session-workspace.css` /
   `sidebar.css`)。机械守卫:`surface-seam-contract.test.ts`(标记形态 + NewLayout 条件 +
   单 Titlebar 渲染点锚点)、`alpha-session-workspace.test.ts`(声明点 + 拖拽区 CSS 锚点)、
   `session-workspace.cases.ts`(真挂载 DOM 恰一个 header)。
3. **回退**:从 patch 序列移除该条件与字段即蒸发(NewLayout 恢复无条件渲染 Titlebar);
   seam 契约测试先红,不会静默漂移。
