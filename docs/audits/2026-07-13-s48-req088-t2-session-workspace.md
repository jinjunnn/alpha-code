# S48 REQ-088 T2:AlphaSessionWorkspace 外框正式化(2026-07-13)

- Issue:jinjunnn/alpha-code#181(REQ-088);spike 任务分解 T2
  (docs/audits/2026-07-12-req087-legacy-session-adapter.md §9)
- 交付:REQ-087 spike 的 surface 侧原型转正为
  `packages/ui-mac/src/renderer/alpha-ui/session-workspace/alpha-session-workspace.tsx`
  (正式 chrome + SurfaceBoundary + C1 窄导出叶),并落 C4 探针矩阵取证
  (docs/audits/2026-07-13-s48-req088-c4/)点名的三项携带项。
- 发布态**未动**:`SURFACE_RELEASE_STATES.session === "legacy"`(characterization 测试断言);
  adapter 模式仍由双闸控制(`ALPHA_SURFACE_SESSION=alpha` env-override + localStorage
  `ALPHA_SESSION_SPIKE` 闸),任一闸关 ⇒ seam 走上游默认叶,零变化。发布态阶梯归 T5。
- 门禁(本 worktree,基点 4cc65aa2):`bun test src` **1287 pass / 0 fail**(前基线 1267;
  新增 20 用例);`bun run --cwd packages/ui-mac typecheck`(tsgo -b)干净;
  `scripts/verify-freeze-restore.sh` 绿(frontend-freeze-base-3,冻结面零触碰);
  `scripts/alpha-check.sh` 三门全绿;`electron-vite build` ✓(session 叶仍单一 lazy chunk)。

## 1. 形态(spike → 正式)

| 面 | spike(session-spike-host.tsx 旧 sessionSpikeSurface) | 正式(session-workspace/) |
|---|---|---|
| chrome | 橙色调试条(内联样式,"ALPHA FRAME(REQ-087 原型)") | header/上下文条:项目 basename + 会话尾 8 位 + Alpha 徽标;alpha 设计语言(tokens.css `--a-*`,`a-swk-*` 类,session-workspace.css) |
| 叶包裹 | 内联 `flex:1;min-height:0` | 同一形态经 CSS 类固化(R1 红线钉测) |
| 边界 | SurfaceBoundary(致命 → 记录 → reload 回 legacy) | 同,语义不变(C4 已真机实证);其内新增 CrossServerGuard 有界引导(§2.2) |
| 窄导出消费 | spike host 文件 | 迁至 workspace 文件,仍为**全仓唯一消费点**(req087-characterization §6 改为全 renderer 步进扫描断言) |
| 容器侧探针 | 同文件 | 保留在 session-spike/(探针口径修正见 §2.1),T7 统一清理 |

`.a-ui`(alpha 排版作用域)只挂 chrome 与引导卡,**不挂**外层/叶包裹 —— alpha 字体/颜色
不得级联进上游叶,legacy 视觉 parity 优先。

## 2. C4 携带项处置

### 2.1 ①探针 0ms 采样口径修正(spike-probe-core.ts)

- 新增 pending 分流:session 路由采样 `terminalPanels === 0` = 叶未挂载(0 永远不可能是
  双挂载信号,双挂载 ≥2)——不计违规、不进累积序列;`summary()` 新增 `pendingSamples`
  字段如实上报,`formatSample` 加 `state=pending` 标注,overlay 显示 pend 计数。
- 单测复现 C4 README §口径缺口的三处假阳性序列(0/92 锚定)修正后为 0 违规/0 累积;
  真双挂载(≥2)与真累积(settled 序列单调升)仍然报警(反向用例)。

### 2.2 ②server-awareness 最小安全解(C4 S5 发现 1/2 的处置)

- 处置:workspace 叶包裹内新增 **CrossServerGuard**(SurfaceBoundary 之内、叶之外)。
  有界识别引擎 control-plane 错误族 `Session not found: <id>`(纯文案匹配,
  session-workspace-core.ts `isCrossServerSessionError`,有单测)→ 渲染引导卡
  (「此会话不属于当前连接的服务器」+ 重新加载(回到本地引擎)/ 返回首页),
  **不落 surface 致命 fallback**(跨 server 点击是用户态,不是 alpha surface 缺陷,
  不应污染 auto-fallback 的崩溃记录,T5 升 auto-fallback 后此点变成正确性问题)。
- 识别不到的任何错误在 fallback 渲染期同步 rethrow → SurfaceBoundary,致命链路
  (记录 → fallback → reload 回 legacy)保持 C4 实证语义。文案漂移的降级方向安全:
  识别失败只是退回现状(fatal fallback),不会吞新错误。
- 未做(明确不在 T2):侧栏按 active server 禁用会话行 —— active server 状态在上游私有
  context/persist(`server.v3`),REQ-091 runtime parity 前 alpha 侧无合法读取通道
  (窄 API 纪律:状态读取仅允许 DOM 锚点);server 间切换 UI 缺口(DialogSelectServer
  onSelect 在 newLayoutDesigns 下 no-op)归 REQ-089/091 路线裁决。

### 2.3 ③侧栏接 preload 消冷入场

- workspace 导出 `preloadSessionLeaf()`(幂等,触发窄导出 lazy chunk 预取;与 seam 的
  `Comp.preload` 同一实现);alpha 侧栏在会话行 `onMouseEnter`、`openSession`(键盘/无
  hover 兜底)、`startChat`(与 createSession 并行)三处接线。
- 窄导出与上游 `lazy("@/pages/session")` 解析到同一模块 id ⇒ legacy 模式同样受益,
  无双份打包(build 取证:session chunk 单一)。

## 3. 宿主红线落测试(T6 审计 §3/§7.2 的输入)

新增 `session-workspace/alpha-session-workspace.test.ts`(14 用例):

- **R1**:外框/叶包裹普通流锚点(`.a-swk-root` flex 列 + `height:100%` + `min-height:0`、
  `.a-swk-leaf` `flex:1`+`min-height:0`);tsx/css 全文禁 `display:none`、`position:fixed`、
  `visibility:hidden`;无 iframe。
- **R2**:workspace 自渲染 data-* 属性一律 `data-alpha-` 前缀(负向前瞻正则扫全文);
  上游锚点名(manifest 内外 11 个 token)零出现 —— takeover/anchor-audit 不会误收 chrome。
- **R7 / Stage C-1**:不 import 三个 takeover 模块;不 import / 不渲染 AlphaComposer
  (Stage C-1 要求与 takeover gate 同 PR,见 T6 审计 §4.1;ComposerTakeover 继续双模式生效)。
- 双闸工厂形态、SurfaceBoundary 组合、rethrow 纪律、seam preload 契约、侧栏预热接线逐条钉死。

另:req087-characterization §6 的唯一消费点断言由钉文件名升级为全 renderer 非测试源码
步进扫描(恰好一个文件消费窄导出);takeover-adapter-coexistence 测试③(消费者无 iframe,
不钉文件名)对本次改名免疫,原样通过。

## 4. 给 T3(live characterization 对比)与视觉验收的注意点

1. chrome 高度 30px(spike 期 26px)——AC5 长 timeline 首屏/跟底/上翻在 adapter 模式的
   对比基线需以本外框重跑(spike 报告 R3 / T6 审计 R6 既有项)。
2. CrossServerGuard 的 rethrow(fallback 渲染期同步 throw → 外层边界)是 Solid 边界组合
   语义,静态测试只能钉源码形态 —— 真机验收建议补一条:跨 server 点击(C4 S5 复现步骤)
   预期看到引导卡而非 SurfaceBoundary fallback;制造非该族的叶致命错误仍走 fallback。
3. 探针 summary 形状变更:`pendingSamples` 新字段;C4 式取证脚本若断言 summary 字面形状
   需同步;violations/acc 口径修正后 fresh-window 不再恒 +1。
4. 视觉验收关注:chrome 亮/暗两态(tokens.css 变量)、上下文条超长项目名截断、
   `新会话`(无 id 过渡态)显示、引导卡布局;overlay(spike 探针)与 chrome 同屏时的遮挡。
5. 侧栏 hover 预热可在 dev 网络面板取证:hover 会话行即触发 session chunk 拉取,
   点击后 0ms 采样应不再出现 `state=pending`(或显著减少)。
