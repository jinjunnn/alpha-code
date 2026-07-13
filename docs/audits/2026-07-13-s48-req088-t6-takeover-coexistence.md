# S48 REQ-088 T6:takeover × adapter 共存审计(2026-07-13)

- Issue:jinjunnn/alpha-code#181(REQ-088);spike 任务分解 T6
  (docs/audits/2026-07-12-req087-legacy-session-adapter.md §9)
- 审计对象:`ComposerTakeover` / `ModelPickerInject` / `TimelineInject`
  (packages/ui-mac/src/renderer/alpha-ui/{composer-takeover,model-picker-inject,timeline-inject}.tsx)
- 判定:**三个 takeover 在 adapter 模式(session 叶经 `@opencode-ai/app/surface/session` 挂进
  Alpha 外框)按 DOM 继续生效,「挂载方式无关」成立**;成立依赖三条结构不变量(§1),已全部
  钉成静态测试(takeover-adapter-coexistence.test.ts,19 用例)。运行时半边给出 CDP 探针清单(§5)。
- 门禁:`bun test src` 1267 pass / 0 fail;`bun run --cwd packages/ui-mac typecheck`(tsgo -b)干净。
- 本档不改任何 takeover/产品代码;T2(AlphaSessionWorkspace 正式化)在飞,其领地文件未触碰。

## 1. 「挂载方式无关」的结构根因(三条不变量)

| # | 不变量 | 证据 | 静态钉点 |
|---|---|---|---|
| ① | takeover 作为 `AppInterface` children 在 router root 挂载一次,不在任何 surface 工厂/叶内;adapter 换叶不触碰其生命周期 | renderer/index.tsx:499-507(三个 `AlphaBoundary` children);surfaces 注入在 index.tsx:442-461,与 children 通道正交 | 新测试 ① |
| ② | 观察面 = `document.body` MutationObserver + document 级 capture 事件 + 全局选择器;只依赖上游叶渲染出的 DOM,不依赖叶怎么被挂进来 | composer-takeover.tsx:88-89;model-picker-inject.tsx:135-136;timeline-inject.tsx:416-419 | 新测试 ①(observer 基线=3) |
| ③ | adapter 在**同一 document** 渲染同一个上游叶:seam XOR(app.tsx:466)+ 窄导出(app/package.json `"./surface/session"`)+ 宿主为普通 div 流(session-spike-host.tsx:196-206,无 iframe) | spike 报告 §2(c) 已证 iframe 形态断裂;C1 已合法化窄导出 | 新测试 ③(消费者无 iframe) |

推论:adapter 模式下叶渲染的 DOM 与 legacy 逐字节同源(同一组件、同一 providers 生命周期,
app.tsx:103-105),takeover 的选择器/时序/事件/样式假设不因挂载方式而变;唯一新增变量是
Alpha 外框的包裹盒与 chrome(风险见 §3)。

## 2. 审计矩阵(逐 takeover × 假设 × 证据 × 风险)

### 2.1 ComposerTakeover(composer-takeover.tsx)

| 假设 | 内容与证据(file:line) | legacy 证据 | adapter 证据 | 风险 |
|---|---|---|---|---|
| 选择器 | `[data-component=session-composer]`(:20)← 上游三元渲染 prompt-input.tsx:1517;**仅在 `newLayoutDesigns` 分支渲染**(:1514),alpha 主进程种子恒 true(main/alpha-defaults.ts:43-47) | REQ-055 已上线;REQ-005 基线审计 §0.1(锚点假死勘误) | C4 真机:全场景稳态 composer 可见 1/1(docs/audits/2026-07-13-s48-req088-c4,10-s0 等 JSON) | 该锚点在 upstream-anchors.json 落 **knownDead(假死)**,上游改名原本不红任何测试 —— 缺口已由新测试补钉 |
| 挂载点 | host div 插在 composer 的 `parentElement` 内、composer 之前(:33-41)—— 父容器在叶子树内,与外框无关 | 同上 | 叶 DOM 同源(§1③) | 若宿主 chrome 自渲染同名锚点会被误收 → §3 R2 |
| 可见性口径 | `parentElement.offsetParent !== null` 选活 composer(:52),兜底 `?? composers[0]` | keep-alive 隐藏 timeline 各有一个 composer,口径已实证(:50-52 注释) | spike 外框为普通 flex 流(session-spike-host.tsx:198-204),offsetParent 语义不变 | 宿主若用 `display:none` 包活叶,口径失真 → §3 R1 |
| 时序 | MO(body,subtree)+ 0ms debounce + 挂载重试 80/250/600/1200ms(:76-90) | 上线稳定 | adapter 叶 lazy chunk 冷加载晚于重试窗也无碍:MO 兜住(C4 S0:0ms 采样 composer 0 → 650ms 1/1) | 无 |
| 样式 | body flag `data-alpha-composer-takeover`(:45/49/94)+ alpha-composer.css:256-258 `display:none !important`(**隐藏保留 DOM**,上游命令注册/状态面存活) | 同上 | flag 挂 body,与叶挂载方式无关 | SurfaceBoundary fallback 屏上 flag 残留(无害,见 §3 R5) |
| 路由 | `parseRoute`(legacy-route-abi,:16)只认带 id 会话页(:22-26) | ABI 有单测 | seam 不改路由形状(req087-characterization §2 已钉) | 无 |
| usage-ring 收养 | `button:has([data-component="progress-circle"])` 移入 `[data-alpha-usage-host]`(:60-73)—— **物理 reparent 上游 Solid 所有的节点** | 上线稳定(REQ-055 v2 换 SSE 自建为既定路线) | 与挂载方式无关(document 级查找) | 双模式同险:上游对该按钮 re-render 时行为依赖 Solid 内部;退役裁决见 §4(REQ-088 AC8 点名) |

### 2.2 ModelPickerInject(model-picker-inject.tsx)

| 假设 | 内容与证据 | legacy 证据 | adapter 证据 | 风险 |
|---|---|---|---|---|
| 选择器(弹层) | `[data-component='list']`+`[data-slot='list-scroll']`+`closest("[role='dialog']")`(:104-111);provider-select 经 bare-key 启发式排除(:109-110) | 上线稳定 | **弹层经 `<Kobalte.Portal>` 挂 body**(dialog-select-model.tsx:142)—— 根本不在叶子树内,adapter 零影响 | `role='dialog'`/`data-popper-positioner` 是 Kobalte 库内部(§3 R4);positioner 有 `?? dlg.parentElement` 兜底(:166) |
| 选择器(行) | `[data-slot='list-item'][data-key]`、`data-selected`(:107,119)← ui list.tsx:340-343 | 同上 | 同上(body 级) | `data-key/data-selected` 在 REQ-012 命名空间外 —— 已补钉 |
| 入口时序 | 弹层由上游叶内触发(`model.choose` mod+' = use-session-commands.tsx:515;`data-action=prompt-model` 按钮在被隐藏的上游 composer 内) | 上线稳定 | 命令注册面随同一叶在 adapter 内原样存活(C4:cmd 117 恒定) | 无 |
| 事件 | 选行 = 点击隐藏 native 行触发上游 `model.set`(:274-275);locked 行走 IPC(:255-272) | 上线稳定 | 与挂载方式无关 | 无 |
| 样式/锚定 | home 锚定启发式:有可见 `.a-chip-model` 才打 `[data-alpha-home-anchor]`(:164-178) | 上线稳定 | 与挂载方式无关 | **O1(双模式同现,注释过时)**:AlphaComposer 会话模式同样渲染 `.a-chip-model`(alpha-composer.tsx:246),会话内开 native picker 也会命中锚定分支 —— 行为可能恰好合理(钉到可见 alpha chip 上方),真机探针 P4 取证,不在本任务改码 |

### 2.3 TimelineInject(timeline-inject.tsx)

| 假设 | 内容与证据 | legacy 证据 | adapter 证据 | 风险 |
|---|---|---|---|---|
| 选择器(主体) | tool-trigger/tool-part-wrapper/tool-output/context-tool-group-trigger/session-turn/user-message/session-turn-diffs-group/basic-tool 各 slot/collapsible-arrow/bash-output/write|edit|apply-patch-tool/task-tool-card/exa-tool-output(:42-62,376-385)| 全部在 upstream-anchors.json **alive**(REQ-012 红线保护) | 叶 DOM 同源;C4 截图 timeline 正常(10-s0 等) | 上游改名由 REQ-012 拦截(既有防线) |
| 选择器(manifest 外) | `data-slash-id`(slash-popover.tsx:104)、`data-message-id`(message-timeline.tsx:1010)、`data-timeline-part-id`(message-part.tsx:1131)、`aria-controls/id="review-panel"`(session-header.tsx:472,543 / session-side-panel.tsx:218)、`data-kind=tool-error-card`(tool-error-card.tsx:94) | 上线稳定 | 同上 | REQ-012 命名空间外 —— 已补钉 |
| 数据格式 | 目录网格解析上游 read 工具输出的 `<entries>` 包裹 + `(N entries)` 尾行(:100-137)← opencode/src/tool/read.ts:277 | 上线稳定 | 与 DOM 挂载无关(文本格式) | 格式变 → 静默不装饰(有 hard guard 不误伤 glob/grep)—— 已补钉格式锚点 |
| 时序 | MO + 0ms debounce + 120/400/900ms 重试(:388-416);幂等 marker attr(data-alpha-tc-ico 等);虚拟列表行回收后由 MO 重装饰 | 上线稳定 | 同 §2.1 时序行 | 分隔线以 sibling 插进虚拟列表容器(:361-366),对虚拟测量是外来高度 —— 双模式同险,外框再减 26px 视口(spike R3);AC5 live characterization 兜 |
| 事件 | document **capture** 级 keydown(Enter)/click(:397-419)—— capture 先于叶内 handler,与叶位置无关 | 上线稳定 | 与挂载方式无关 | **O2(双模式同现)**:captureSend 读上游 composer 输入(:277-283),而 ComposerTakeover 下用户实际输入在 AlphaComposer —— live slash 捕获路径疑似仅剩历史价值(localStorage 折叠仍生效);真机探针 P3 顺带取证,处置归 §4 TimelineInject 迁移清单 |
| 样式 | timeline/*.css 全部锚在 data-attr 与 alpha 类,无布局祖先组合器(grep 验证:无 `main >`/`body >`/`#root` 结构选择器) | 上线稳定 | 外框包裹不影响 | 无 |

## 3. adapter 模式风险清单(何种条件下断)

| # | 风险 | 断裂条件 | 缓解/约束(给 T2 与后续) |
|---|---|---|---|
| R1 | offsetParent 可见性口径失真(composer-takeover.tsx:52,68;model-picker-inject.tsx:169) | AlphaSessionWorkspace 用 `display:none` 隐藏活叶(keep-alive/切换过渡),或给叶包裹盒加 `position:fixed` | **宿主约束**:活叶包裹保持普通流(spike 的 `flex:1;min-height:0` 形态);隐藏非活叶可以(与上游 keep-alive 同语义),隐藏活叶不行 |
| R2 | 宿主 chrome 被 takeover 误收 | chrome 自渲染上游锚点名(`data-component=session-composer`/`progress-circle` 按钮形态/`data-slash-id` 等)或 `.a-chip-model` 同名类 | **宿主约束**:chrome 一律用 `data-alpha-*` 命名空间(anchor-audit 已把 alpha- 前缀排除在引用集外,天然免疫) |
| R3 | 双 alpha composer | workspace 自渲染 AlphaComposer(REQ-088 交付物 1/5)而 ComposerTakeover 未同步去激活 | 退役阶梯 Stage C-1(§4)必须与 workspace composer **同 PR** 落地(AC2/AC8 红线) |
| R4 | Kobalte 内部锚点(`role='dialog'`、`data-popper-positioner`)随库升级漂移 | @kobalte/core 升级 | 静态不可钉(库内部);positioner 有 parentElement 兜底;真机探针 P4 为回归口径 |
| R5 | SurfaceBoundary fallback 屏上 body takeover flag 残留 | 叶致命错误 → fallback UI(路由仍是 session,flag 保持) | 现状无害(fallback 屏无 composer,隐藏规则匹配空集);fallback → reload 回 legacy 后全量重建(C4 S5 实证 57/58 png)。若未来 fallback UI 要渲染任何 composer,先清 flag |
| R6 | 外框高度改变 timeline 虚拟测量/跟底 | chrome header 占高(spike 26px) | spike R3 既有项;AC5 live characterization(C2 套件)兜底,T6 不重复裁决 |
| R7 | takeover 被移进叶内/workspace 内(破坏不变量①) | 未来重构把三件挂进 surface 工厂 → 生命周期随叶重挂,observer 随 keep-alive 翻倍 | 新测试 ①(children 挂载 + observer 基线=3)作红线 |

## 4. 退役时点裁决(草案;供 #181 评论与未来 ADR 引用)

总原则(与 REQ-088 交付物 5 / AC8 对齐):**「去激活」与「删除」分两级**。去激活 = alpha session
路径不再执行(legacy 回退路径保留);删除 = 代码+CSS+挂载行移除。凡 `SURFACE_RELEASE_STATES.session`
仍含 legacy 回退语义(legacy / auto-fallback),legacy 路径的 takeover 不得先删 —— 回退可用性
(AC9)优先。

### 4.1 ComposerTakeover(含 body flag、host Portal、usage-ring 收养、alpha-composer.css:256 隐藏规则)

- **REQ-088 当前阶段(外框期,T2)**:保留、双模式生效 —— 它是 adapter 模式「唯一可编辑 composer =
  AlphaComposer」的现役提供者(AC2 由 CSS hide + Portal 满足)。
- **Stage C-1(去激活,REQ-088 内)**:当 SessionWorkspace ConversationRegion 自渲染 AlphaComposer
  之时(交付物 1/5),**同一 PR** 给 ComposerTakeover 加 surface-mode gate(session 生效模式 =
  alpha ⇒ 整件 no-op,不设 body flag、不建 host、不收养 ring)。触发 AC8「在 Alpha session 路径
  不再执行」。判定信号建议:resolvedSurfaces(启动期一次性)经 props/module 传入,禁止运行时热切。
- **Stage C-2(删除)**:同时满足 ①session 发布态升 `alpha` 且 auto-fallback 观察期通过(建议
  连续 2 个发布周期 crash-fallback 记录为 0);②产品裁决接受「legacy 回退呈现上游原生 composer
  视觉」(功能完备、无 alpha 皮)。届时删 composer-takeover.tsx + alpha-composer.css 隐藏段 +
  index.tsx 挂载行 + upstream-anchors 再生成。
- **回退考量**:Stage C-1 后 auto-fallback 踩崩回 legacy 时 takeover 仍在 → 回退体验不降级;
  Stage C-2 前置 ② 就是为了把「回退丢 alpha 视觉」变成显式产品决定而非事故。
- usage-ring 收养单独提前退役窗口:REQ-055 既定 v2 = SSE 自建 ring,可先于 Stage C-1 独立替换
  (最脆的一处 DOM 收养,见 §2.1)。

### 4.2 ModelPickerInject

- **REQ-088 当前阶段**:保留、双模式生效。绑定对象是 body 级弹层而非叶,adapter 交付对它零语义
  变化;且它承载账户/代理分组、充值/登录引导(商业面),现无等价替代覆盖全部入口。
- **Stage M-1(去激活)**:当上游 native picker 在 alpha 路径不再可达时 —— 即 `model.choose`
  命令与隐藏 composer 的 prompt-model 入口都被 alpha 自建 picker(ModelPickPop)接管/屏蔽。
  命令注册面属上游叶(use-session-commands.tsx:515),REQ-088 期间持续存在 ⇒ **REQ-088 内不具备
  去激活条件**;归 REQ-089(route/命令组合所有权)或 REQ-091(runtime parity)裁决。
- **Stage M-2(删除)**:与 C-2 同批(legacy 回退退出承诺后);删除即回退到上游原生 picker,
  **丢失代理/计费引导 UI** —— 删除前必须确认 alpha 自建 picker 覆盖全部触达路径。
- **回退考量**:三件中回退代价最高(商业引导面),建议排最后删。

### 4.3 TimelineInject

- **REQ-088 当前阶段**:保留、双模式生效(spike T6 括注「REQ-087 非目标保留」的本体)。
- **退役形态 = 分项迁移清单**(AC8 要求逐项有 owner/删除 REQ),非整件开关:

  | 装饰项 | 退役条件 | 建议归属 |
  |---|---|---|
  | tc-ico 类型图标 / context-group 图标 | alpha-owned timeline 组件原生渲染类型图标 | REQ-091 后的 timeline 原生化 REQ(建议 REQ-089/091 立项时同步开「timeline decorations 原生化」子 REQ) |
  | dirgrid 目录网格 | 同上,或上游吸收结构化目录输出 | 同上 |
  | 「在面板打开」pill(file/diff) | Workbench 入口(REQ-088 交付物 4)覆盖同一动线后,pill 是首个可退役项 —— **REQ-088 内可裁决** | REQ-088 验收时点名 |
  | bash 退出徽标(TL-17,含已知 FLAG) | 上游暴露 metadata.exit 或 alpha timeline 原生化 | 同 tc-ico |
  | 回合分隔线(TL-34) | alpha timeline 原生化 | 同上 |
  | cmd chip(TL-05,含 send 捕获) | **观察项 O2**:takeover 下 live 捕获路径疑似已失效(§2.3),真机取证后若确认,可先摘除捕获监听、保留 localStorage 折叠渲染 | REQ-088 验收顺带取证,处置单列 |

- **Stage T-2(整件删除)**:全部分项迁完即删;与 C-2/M-2 无强耦合(纯视觉+便利,无正确性影响;
  `alpha-cmd:*` localStorage 残留无害)。
- **回退考量**:删除后 legacy/adapter 均失去装饰,无功能损失。
- **observer 预算**(AC8「结构 observer 总数不得增加」):现役基线 = 3(每件 1 个),已钉测试;
  任何新增结构 observer 须先减后加。

## 5. 真机验收 CDP 探针清单(主会话用;双闸 adapter 模式 + legacy 对照各跑一遍)

前置同 C4 取证(dev + CDP 9222;`ALPHA_SURFACE_SESSION=alpha` + spike/workspace 闸;MemoryRouter
⇒ 导航走真实 UI)。以下 `Runtime.evaluate` 表达式,期望值 adapter/legacy 两列应相等(P6 除外):

- **P1 ComposerTakeover 生效**(session 路由上):
  - `document.body.hasAttribute("data-alpha-composer-takeover")` → true
  - `[...document.querySelectorAll("[data-alpha-composer-host]")].filter(h=>h.offsetParent!==null).length` → 1
  - `getComputedStyle(document.querySelector("[data-component=session-composer]")).display` → "none"
  - `!!document.querySelector("[data-alpha-composer-host] [data-alpha-composer=session]")` → true
- **P2 发送链路**:经 alpha composer 输入并发送 → timeline 新增 `[data-component=user-message]`
  (计数 +1);发送后 composer 聚焦仍在 alpha 输入框。
- **P3 TimelineInject 装饰**(种 bash+read+edit 轮次后):
  - `document.querySelectorAll("[data-alpha-tc-ico]").length` > 0
  - `document.querySelectorAll(".a-exit[data-ok]").length` ≥ 1(完成的 bash)
  - `document.querySelectorAll(".a-turn-div").length` === 用户轮次数 − 1
  - 目录 read 轮次:`!!document.querySelector("[data-alpha-dirgrid]")` → true
  - O2 取证:composer 里输入 `/xxx args` 发送,观察 `pendingCmd` 路径是否成立
    (`document.querySelectorAll(".a-cmd-chip").length` 是否 +1)
- **P4 ModelPickerInject 生效**(会话内 mod+' 打开 native picker):
  - `!!document.querySelector("[role=dialog] [data-alpha-picker]")` → true
  - native 行仍在且被盖:`document.querySelectorAll("[data-slot=list-item][data-key]").length` > 0
  - 经 alpha 行点选一个未锁模型 → `document.querySelector("[data-slot=list-item][data-selected=true]")`
    的 data-key 变化(上游 model.set 真的走到)
  - O1 取证:记录 `!!document.querySelector("[data-alpha-home-anchor]")` 与弹层视觉位置截图
- **P5 模式对照**:P1/P3/P4 全部断言在 legacy(闸关)模式重跑,数值一致。
- **P6 切换/reload 稳定性**(仅 adapter):A↔B 快切 ×3 + reload 后重跑 P1;
  `window.__req087Spike.summary()` violations 不随操作增长(C4 口径,注意 0ms 采样已知假阳性)。

## 6. 新增测试与门禁结果

- 新增:`packages/ui-mac/src/renderer/alpha-ui/takeover-adapter-coexistence.test.ts`
  —— 19 用例 / 45 断言,5 组:①挂载通道零耦合(children 挂载、无 @opencode-ai/app import、
  observer 基线=3、document 级事件、route ABI)③窄导出消费者无 iframe(不钉宿主文件名,
  T2 改名免疫)②a composer 锚点(三元渲染点补钉 knownDead 假死缺口、newLayoutDesigns 前置、
  CSS/flag 成对、offsetParent 口径、progress-circle)②b picker 锚点(Kobalte Portal、
  list 行契约、隐藏行点击通路)②c timeline manifest 外锚点(slash-id/message-id/part-id/
  review-panel/tool-error-card/`<entries>` 格式)。
- 测试文件按 anchor-audit walk 规则被排除在锚点引用集外,upstream-anchors.json 无需再生成。
- 门禁:新文件 19 pass / 0 fail;全量 `bun test src` **1267 pass / 0 fail**;
  `bun run --cwd packages/ui-mac typecheck` 干净(T2 中间态未影响本次运行)。

## 7. 遗留风险与开放项

1. O1/O2(§2.2/§2.3)是**双模式同现**的观察项,不阻塞 T6 判定;真机探针 P3/P4 顺带取证后
   在 #181 记录处置(O2 若证实,归 TimelineInject 迁移清单先摘捕获监听)。
2. 宿主约束 R1/R2(§3)是给 T2 的红线输入,静态测试无法预防未来 chrome 文件 —— 建议 T2 落地时
   在 workspace 自己的测试里断言 chrome 不含上游锚点命名。
3. Stage C-1 的「同 PR 落地」纪律(R3)靠评审执行;可在 workspace 渲染 AlphaComposer 的 PR 中
   给新测试 ① 增补「alpha 路径 gate 存在」断言(届时改由该 PR 负责,不预写)。
4. Kobalte 内部锚点(R4)无静态防线,回归口径 = 探针 P4。
