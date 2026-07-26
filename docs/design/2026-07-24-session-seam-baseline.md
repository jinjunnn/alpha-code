---
title: REQ-125 会话页 seam surface 重构方案基线
kind: design
status: frozen
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-25
---

> 2026-07-24 rev2:Codex 开发前问询回写(GO with revisions);回落语义遵 REQ-090 单向门。

# REQ-125 · 会话页 seam surface 重构 — 方案基线

已批 UI 基线:[`current/session-workspace/design.html`](current/session-workspace/design.html)
(整页/顶栏/右栏四面板)+ [`current/conversation-timeline/design.html`](current/conversation-timeline/design.html)
(时间线组件全量活稿;其「实现接缝表」CSS/INJECT 口径已被本基线取代,仅作构件完备性
清单)。本文是其技术方案面,四段:勘破 / 方案与被否决替代 / 安全不变量 / 子票切分。

## ① 只读勘破(地面真相,2026-07-23/24 实测;rev2 经 Codex 复核修正)

**表面选择链**(现状,不在本 REQ 改动面):
`shared/alpha-surfaces.ts` `SURFACE_RELEASE_STATES.session="alpha"` → `main/alpha-surfaces.ts`
`resolveSurfaces()`(env `ALPHA_SURFACE_SESSION` > userData pin > 发布默认;仅启动期生效)
→ IPC `alpha-surfaces-resolve` → `renderer/index.tsx` 组装 → 上游 seam
`packages/app/src/app.tsx`。**v2 真实路由是 `/server/:serverKey/session/:id`**,经
`createTargetSessionRoute` → `TargetSessionRouteContent` 挂载所选叶(app.tsx:261/785),
不是停在 legacy `createSessionRoute`。

**alpha 侧路由识别缺口(C1a 首修项)**:alpha `shared/route-manifest.ts` 的 session 条目
现仅编码 legacy `/:dir/session/:id`;`WorkspaceChrome`/`alpha-session-workspace` 用它解析
pathname,因此对真实 v2 target 路由**拿不到 project/session 上下文**。这不能留到 C8,
C1/C7 首先依赖真实会话身份。

**崩溃处置现行合同**:alpha surface 致命 render 错误 → `SurfaceBoundary` 建立稳定
incident + **Alpha Recovery,明文禁止回退 legacy**(renderer/index.tsx:482 注释、
`surface-boundary.tsx`)。不存在"运行时回落上游叶"的能力;上游 session 叶仅经 env
`ALPHA_SURFACE_SESSION` / userData pin 在**启动期**可达(逃生阀)。

**事故形态**(2026-07-23):上游 `desktop v2 migration finalising` 随滚动 pin(#474)+ sync
进入,`settings.general.newLayoutDesignsDefault = true` 把上游 session 叶切到 v2 DOM。
alpha 对会话页的介入全部是针对 v1 DOM 的注入(`composer-takeover.tsx` 选择器、
`timeline-inject.tsx` + reskin CSS、审查面板换肤),v2 后整体落空:外框在,内瓤回上游。
**结论:注入档位对滚动 pin 结构性脆弱,每次上游布局迁移都会复发。**

**v2 渲染路径关键事实**(实现锚点,踩错即返工):

- v2 时间线行装配在 `packages/app/src/pages/session/timeline/message-timeline.tsx`
  (自有 TimelineRow switch,行模型 `rows.ts`/`timeline-row.ts`);不走 `SessionTurn`,
  `MessageNav` 未接线。
- `session-ui/src/v2/components/basic-tool-v2.tsx`、`tool-error-card-v2.tsx` 是**孤儿文件**:
  真实工具卡 = v1 `basic-tool.tsx` + `message-part.css` 的 `data-new-layout` 选择器。
- timeline 真接线的 v2 组件仅 3 个:`AttachmentCardV2`、`CommentCardV2`(经
  `UserMessageComments`)、`SessionProgressIndicatorV2`(task running)。
- 时间线行过滤与 dock 的关系(rev2 修正):`HIDDEN_TOOLS` **仅含 `todowrite`**
  (message-part.tsx:617);pending/running question 是**单独条件过滤**,渲染在 composer
  dock(`pages/session/composer/session-*-dock.tsx`);**PermissionV2 不属于 dock 集合**,
  当前经独立 Permission surface/dialog 渲染(`createPermissionSurfaceMount` /
  `PermissionWatcher`)。
- 回合级 Error 行(`rows.ts` Error row)与工具级错误卡是两个组件、两个数据源。
- 会话数据源:SDK/事件流(messages/parts/status)+ diff、文件、终端各有既有 typed
  通道;上游组件是这些数据的消费者,不是唯一供体。

## ② 选定方案与被否决替代

**选定:按 `system/replacing-opencode.md` 阶梯,把会话页一次升到 seam surface ——
整页 seam + 非布局内核白名单复用。** `alphaSessionWorkspaceSurface()` 返回的组件从
"薄外框 + 内嵌上游 SessionPage"改为**整页 alpha 自持渲染**:单一顶栏、时间线、
composer 直挂、右栏四面板(审查/文件/终端/产物)。边界如下:

- **alpha 自持**:行模型/虚拟化、卡片外壳、交互、CSS(`--a-*` 令牌)——整页 DOM 的
  形态权威在 alpha,零依赖上游 session DOM/选择器/CSS。
- **数据面**:只经既有 `useServerSync`/`useServerSDK`/SDK/IPC typed 通道消费;确缺
  能力才补一个窄 export,**不新造通用 headless Session 框架**。
- **白名单复用经审计的非布局内容引擎**:Markdown sanitize/Shiki、diff、Ghostty 终端、
  artifact renderer。**不复用**上游 `MessageTimeline`/`MessagePart`/工具视觉组件整件,
  **也不重写**这些安全关键引擎。
- **工具卡形态**:一个通用 `ToolCard`(四态)+ 当前确有数据差异的少量分支;未知工具
  fail-closed 渲染为有界纯文本通用卡。不为约 40 个视觉构件逐一造组件——活稿构件
  清单是完备性对照,不是组件清单。
- **回落语义(REQ-090 单向门,既定合同不动)**:alpha 会话页崩溃 → Alpha Recovery
  (现行 surface-boundary 合同),**不新增运行时回落上游叶**;上游 session 叶仅经 env
  `ALPHA_SURFACE_SESSION` / userData pin 在启动期可达(逃生阀)。

**权威性反问**:本方案后,alpha 会话页是形态权威——上游怎么改布局都影射不到
alpha 页。**不再逐点同步上游 DOM/CSS**;SDK schema、消息语义、prompt/abort/queue、
权限、终端与 diff 行为仍按契约验证(contracts/typed adapters 把守)。被否决替代:

- ❌ **修选择器续命**(把 takeover/reskin 适配到 v2 DOM):下次 pin bump 复发,
  已被本次事故证伪;且 = "与外部 DOM 逐点同步"红旗。
- ❌ **fork 上游 session 叶改造**:等于回到冻结模型,违 ADR-034 滚动 pin,白嫖终止。
- ❌ **补丁改上游 v2 布局**:UPSTREAM_PATHS 禁区 + 补丁序列膨胀,north-star 守卫红。
- ❌ **timeline 继续 CSS reskin、只重做右栏**:时间线是会话页主体,留在注入档 =
  保留主要回归面,阶梯规则明禁"reskin 越堆越厚"。

**产物面板**:不重做,嵌既有 alpha `artifact-workbench`(REQ-094/097 资产)。
**终端面板**:嵌既有引擎终端通道,alpha 只做外壳与页签。

## ③ 安全面:整类边界与实现必须守住的不变量

攻击/事故类枚举(类边界前置):

1. **不可信内容渲染**(助手 Markdown/工具输出/diff/终端输出/文件预览,均可能含
   对抗性内容):一律经现有安全渲染管线(Markdown 走既有 sanitize+shiki 通道;diff/
   终端输出纯文本节点渲染;文件预览只走 artifact-workbench 既有 renderer registry,
   不新开预览通道)。**禁止未经既有 sanitizer 管线的 HTML**(既有管线 DOMPurify 后
   注入是合同内行为,新代码不得绕过该管线自行注入)。
2. **渲染进程 CSP**:禁 eval/new Function(ajv 教训,PR#515);新组件不引入运行时
   代码生成依赖;**不为新页面放宽 CSP**。
3. **文件路径面**(右栏文件树/打开文件):renderer **只传工作区相对标识**,main/SDK
   (或 server)是权威解析者;artifact 通道沿既有 inode 硬化范式(O_NOFOLLOW +
   realpath 圈禁 + dev/ino 绑定),普通工作区文件同样由权威侧解析;**禁止把不可信
   绝对路径直接交给通用 openPath**,不在 renderer 拼路径直读。
4. **权限/审批面**:审批 UI 只消费 PermissionV2 typed 通道,fail-closed(读不到 =
   不放行),沿 REQ-090 语义,不新建旁路。
5. **崩溃处置面**:alpha 页崩溃 → **Alpha Recovery(REQ-090 单向门合同)**,只降本
   surface,不降 home/newSession,不回落上游叶;Recovery 路径不依赖 alpha 页任何
   局部状态。
6. **URL/远程资源面**:Markdown 链接、工具返回 URL、终端 hyperlink、图片一律协议
   白名单;外部链接显式外开(不在应用内导航);远程 Markdown 图片按既定政策处理
   (默认不扩大外联面);不为新页面放宽 CSP。
7. **资源耗尽面**:巨型 Markdown/代码块/diff/工具输出/文件预览必须有界渲染或渐进
   加载;**不把超大字符串一次交给 sanitizer/Shiki**;时间线虚拟化不豁免单卡内容上限。
8. **跨会话竞态面**:一切异步结果/事件必须绑定 `serverKey + directory + sessionID`
   才可写入 UI;审批回复额外绑定 request ID,拒绝 stale/重复回复,防止切换会话后
   展示旧内容或回错请求。

不变量(review 轮固定清单):

- I1 **白名单边界**:alpha 会话页代码禁止 import `app/pages/session`、`MessageTimeline`、
  `MessagePart` 及上游工具视觉组件,零查询上游 DOM/选择器;允许列明的内容引擎
  (Markdown sanitize/Shiki、diff、Ghostty、artifact renderer)与公开 typed hooks
  (`useServerSync`/`useServerSDK` 等)。上游 session 叶仅存在于 boundary host 之外的
  启动期组装,alpha 页对其零依赖。静态断言测试守住。
- I2 所有外部数据经 typed adapter/SDK/IPC 进入,消费处 schema-校验或窄类型。
- I3 权限/审批 UI fail-closed;**禁止未经既有 sanitizer 管线的 HTML**。
- I4 崩溃走 **Alpha Recovery 合同**(REQ-090 单向门);Recovery 路径不依赖 alpha 页
  局部状态。
- I5 **令牌白名单**:alpha 外壳/卡片只用 `--a-*`;嵌入引擎可保留内部 token,但不得
  决定 alpha 布局/chrome;零改上游 token/DOM(principles #5/#6)。
- I6 URL/远程资源:协议白名单、外链显式外开、远程 Markdown 图片按政策、不放宽 CSP。
- I7 资源耗尽:有界/渐进渲染;超大内容不整串进 sanitizer/Shiki。
- I8 跨会话竞态:异步结果绑 `serverKey+directory+sessionID`;审批回复绑 request ID,
  拒 stale/重复。

## ④ 子票切分(依赖序;每票边界=具体文件,worktree 独立)

| 票 | 内容 | 依赖 | 主要落点 |
| --- | --- | --- | --- |
| C1 | **两段一票**。C1a 运行时接线:`serverKey/sessionID/directory` 解析、route-manifest 识别 v2 `/server/:serverKey/session/:id`、typed live context、会话切换隔离。C1b 布局骨架与单一顶栏:整页布局宿主(左栏共存/顶栏/中列/右栏宿主/composer 停靠位),替换内嵌上游叶;崩溃处置沿 Alpha Recovery 合同不变 | — | `alpha-ui/session-workspace/*`、`shared/route-manifest.ts` |
| C2 | 右栏审查面板:变更列表、统一/拆分 diff、双空态、行内评论入口 | C1 | `alpha-ui/session-rail/review/*`(新) |
| C3-files | 右栏文件面板(文件访问沿 §③.3 权威解析范式) | C1 | `alpha-ui/session-rail/files/*`(新) |
| C3-term | 右栏终端面板(嵌引擎输出区,alpha 外壳与页签) | C1 | `alpha-ui/session-rail/terminal/*`(新) |
| C4 | 右栏产物面板:嵌 artifact-workbench(承接 #449/#454 挂载点,不重复其实现);时间线产物行联动移入 C6 | C1 | `alpha-ui/session-rail/artifacts/*` |
| C5 | alpha 时间线行模型与文本流:行模型/虚拟化/滚动锚定、用户气泡/助手 Markdown/推理块/分隔/流式,SDK 数据源 | C1 | `alpha-ui/session-timeline/*`(新) |
| C6 | 时间线卡片:通用 `ToolCard` 四态 + 确有数据差异的少量分支、回合级 Error 行、工具级错误卡、附件卡、内联评论卡、重试、折叠组、产物行联动(依赖 C4)、**未知工具 fail-closed 有界纯文本卡**。活稿 40 构件清单作完备性对照,不逐件建组件 | C5(联动另依赖 C4) | `alpha-ui/session-timeline/cards/*` |
| C7 | composer seam 化:AlphaComposer 直挂,覆盖现有全部 dock 状态(todo/question/followup/revert/child-session/handoff;审批走独立 Permission surface,非 dock);2.5s 轮询与直连 `promptAsync` 改为已批稿要求的 live status、停止、运行中 queue/steer 语义;删 Portal/选择器接管 | C1 | `alpha-composer.tsx`、`composer-takeover.tsx`(删)|
| C8 | lineage 翻转 session/composer/timeline → alpha,同步 `frontend-surface-manifest.ts`(含陈旧 session 条目修正)+ PAGE-MAP;清理:删 renderer 中 `ComposerTakeover`/`TimelineInject` 挂载与 import、composer/timeline reskin CSS 入口 | C1–C7 | `shared/frontend-surface-manifest.ts`、`renderer/index.tsx` |
| V1 | [VERIFY][cap:session-visual] seam 会话页 + 时间线组件对照已批稿明暗视觉矩阵;并补功能/安全门:row projection、未知 part fail-closed、流式与历史加载、滚动锚定、会话切换隔离、dock fail-closed、Recovery 路径、旧注入零命中;session/timeline 前后 benchmark(`packages/app/AGENTS.md`) | 随各票 | `docs/verification/` |

并发编排:C1 先行独占(C1a → C1b 两段退出条件);此后 {C2, C3-files, C3-term, C4}、
{C5→C6}、C7 三线可并行(本机 codex 并发上限 2);C8 收尾小票。V1 可攒批执行、
不挡单票开发,但**阻断 REQ-125 关闭**。

> **2026-07-25 owner 裁决(alpha-code#619)**:确认 C7 行的口径 ——「审批走独立
> Permission surface,非 dock」为准;已批整页稿的「变体二 · 审批请求停靠」帧与交互
> 契约表「审批停靠」条作废(已在稿内标注)。依据:dock 审批卡与 REQ-090 已交付的
> PermissionDialog 并存意味着两套审批 UI + `session-approval-claim` 抢占机制的永久
> 维护面;dock 卡仅呈现 2 栏(action/resources)而判定同源于 5 栏事实(scope/expiry
> 被藏成盲签面);Dialog 为强模态 fail-closed(body inert + Esc 不可关)。dock 审批卡
> 与 claim 机制随本裁决删除,反向闸门锁在
> `packages/ui-mac/src/renderer/alpha-ui/takeover-adapter-coexistence.test.ts`。
> 已知代价(owner 知悉并接受):强模态挡住时间线,审批时无法回看工具上下文;缓解 =
> 拒绝成本低,可让 agent 重新发起。
