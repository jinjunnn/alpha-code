---
title: REQ-125 会话页 seam surface 重构方案基线
kind: design
status: frozen
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-24
---

# REQ-125 · 会话页 seam surface 重构 — 方案基线

已批 UI 基线:[`current/session-workspace/design.html`](current/session-workspace/design.html)
(整页/顶栏/右栏四面板)+ [`current/conversation-timeline/design.html`](current/conversation-timeline/design.html)
(时间线组件全量活稿)。本文是其技术方案面,四段:勘破 / 方案与被否决替代 /
安全不变量 / 子票切分。

## ① 只读勘破(地面真相,2026-07-23/24 实测)

**表面选择链**(现状正确,不在本 REQ 改动面):
`shared/alpha-surfaces.ts` `SURFACE_RELEASE_STATES.session="alpha"` → `main/alpha-surfaces.ts`
`resolveSurfaces()`(env `ALPHA_SURFACE_SESSION` > userData pin > 发布默认;崩溃只记录不降级)
→ IPC `alpha-surfaces-resolve` → `renderer/index.tsx` 组装 → 上游 seam
`packages/app/src/app.tsx` `createSessionRoute(props.surfaces?.session ?? Session)`。

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
- permission / todowrite / pending question 不进时间线行(`HIDDEN_TOOLS` 过滤),
  渲染在 composer dock(`pages/session/composer/session-*-dock.tsx`)。
- 回合级 Error 行(`rows.ts` Error row)与工具级错误卡是两个组件、两个数据源。
- 会话数据源:SDK/事件流(messages/parts/status)+ diff、文件、终端各有既有 typed
  通道;上游组件是这些数据的消费者,不是唯一供体。

## ② 选定方案与被否决替代

**选定:按 `system/replacing-opencode.md` 阶梯,把会话页一次升到 seam surface。**
`alphaSessionWorkspaceSurface()` 返回的组件从"薄外框 + 内嵌上游 SessionPage"改为
**整页 alpha 自持渲染**:单一顶栏、时间线、composer 直挂、右栏四面板(审查/文件/
终端/产物),全部 alpha 组件 + `--a-*` 令牌,数据只经 SDK/typed adapters/IPC 消费,
**零依赖上游 session DOM/选择器/CSS**。上游 session 叶保留为 surface-boundary 崩溃
回落路径(env 逃生阀不变)。

**权威性反问**:本方案后,alpha 会话页是形态权威——上游怎么改布局都影射不到
alpha 页(只剩数据契约耦合,由 contracts/typed adapters 把守)。不存在"跟上游逐点
保持同步"的无底洞;这正是被否决替代们的死因:

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
   终端输出纯文本节点渲染,禁 innerHTML;文件预览只走 artifact-workbench 既有
   renderer registry,不新开预览通道)。
2. **渲染进程 CSP**:禁 eval/new Function(ajv 教训,PR#515);新组件不引入运行时
   代码生成依赖。
3. **文件路径面**(右栏文件树/打开文件):复用既有硬化范式(O_NOFOLLOW + realpath
   圈禁 + dev/ino 绑定),不在 renderer 拼路径直读。
4. **权限/审批面**:审批 dock 只消费 PermissionV2 typed 通道,fail-closed(读不到 =
   不放行),沿 REQ-090 语义,不新建旁路。
5. **回落面**:alpha 页崩溃 → surface-boundary 回落上游叶,**只降本 surface**,
   不降 home/newSession;回落路径本身不得依赖 alpha 页任何状态。

不变量(review 轮固定清单):

- I1 alpha 会话页代码 **零 import 上游 session 组件、零查询上游 DOM/选择器**
  (静态断言测试守住)。
- I2 所有外部数据经 typed adapter/SDK/IPC 进入,消费处 schema-校验或窄类型。
- I3 权限/审批 UI fail-closed;不可信内容不经 raw HTML 注入。
- I4 上游叶回落可达且与 alpha 页无共享可变状态。
- I5 只用 `--a-*` 令牌,零改上游 token/DOM(principles #5/#6)。

## ④ 子票切分(依赖序;每票边界=具体文件,worktree 独立)

| 票 | 内容 | 依赖 | 主要落点 |
| --- | --- | --- | --- |
| C1 | seam 骨架 + 单一顶栏:整页布局宿主(左栏共存/顶栏/中列/右栏宿主/composer 停靠位),替换内嵌上游叶,surface-boundary 回落 | — | `alpha-ui/session-workspace/*` |
| C2 | 右栏审查面板:变更列表、统一/拆分 diff、双空态、行内评论入口 | C1 | `alpha-ui/session-rail/review/*`(新) |
| C3 | 右栏文件面板 + 终端面板 | C1 | `alpha-ui/session-rail/{files,terminal}/*`(新) |
| C4 | 右栏产物面板:嵌 artifact-workbench + 时间线产物行联动(承接 #449/#454 挂载点,不重复其实现) | C1 | `alpha-ui/session-rail/artifacts/*` |
| C5 | alpha 时间线消息流:容器/虚拟化/用户气泡/助手 Markdown/推理块/分隔/流式,SDK 数据源 | C1 | `alpha-ui/session-timeline/*`(新) |
| C6 | 时间线卡片全集:工具卡(通用四态 + 全部子类 + task v2 形态)、回合级 Error 卡、工具级错误卡、附件卡、内联评论卡、重试、折叠组 | C5 | `alpha-ui/session-timeline/cards/*` |
| C7 | composer seam 化:AlphaComposer 直挂 + 审批/todo/question dock 接入,删 Portal/选择器接管 | C1 | `alpha-composer.tsx`、`composer-takeover.tsx`(删)|
| C8 | lineage 翻转 session/composer/timeline → alpha,同步 `frontend-surface-manifest.ts`(含陈旧 session 条目修正)+ PAGE-MAP | C1–C7 | `shared/frontend-surface-manifest.ts` |
| V1 | [VERIFY][cap:session-visual] seam 会话页 + 时间线组件对照已批稿明暗视觉矩阵 | 随各票 | `docs/verification/` |

并发编排:C1 先行独占;此后 {C2,C3,C4}、{C5→C6}、C7 三线可并行(本机 codex
并发上限 2);C8 收尾小票。验证不挡开发,V1 攒批执行。
