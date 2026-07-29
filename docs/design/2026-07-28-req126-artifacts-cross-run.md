---
title: 会话右栏产物面板 —— 跨云任务浏览与云端取回(设计稿技术说明)
kind: design
status: draft
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-28
---

# 会话右栏产物面板增量 · 技术说明

设计稿本体:[`2026-07-28-req126-artifacts-cross-run.html`](2026-07-28-req126-artifacts-cross-run.html)
(单文件、本地可开、浅/深双主题、零外部请求)。

本文是它的技术面:血统、每个可点的东西对应哪条真实通道、**已定裁决**、明确划在外面的范围,以及**实现计划**(⑦)。

> **裁决状态**:A / B / C / D / E 已由 owner 于 2026-07-28 全部拍板(见 ④),稿与本文均已按裁决后的形态改写。
> 仍需 owner **最终批准**后才进入实现。

---

## ① 与上一稿的关系

`docs/design/system/contributing.md` R1 要求每份新稿开篇声明它从上一份已批稿继承什么、改什么。本稿的三份上游:

| 上游 | 状态 | 本稿对它做什么 |
| --- | --- | --- |
| [`current/artifact-workbench/design.html`](current/artifact-workbench/design.html)(= 冻结快照 `2026-07-20-req097-office-preview/`,两者逐字节相同) | 已批;PAGE-MAP 指定为「会话产物右栏」的设计权威 | **原样继承**卡片行、六态状态 chip、预览三页签、打开前复核闸门、用量读数与其文案模板。零重定义。 |
| [`current/session-workspace/design.html`](current/session-workspace/design.html) + [`2026-07-24-session-seam-baseline.md`](2026-07-24-session-seam-baseline.md) | 已批 UI 基线 / frozen 技术基线 | **原样继承**右栏宽度契约(默认 400,320–560,左缘 6px 把手)、四面板胶囊条 46px、时间线产物行 → 右栏定位 + Esc 归位的联动合同。已批稿对本面板的原话是「产物面板不做新设计…既批形态原样,这里只画它嵌在右栏 tab 内的上下文」。 |
| [`2026-07-28-req126-shell-navigation-baseline.md`](2026-07-28-req126-shell-navigation-baseline.md) §1.3 / S3 / §4 序 1 | active(rev3) | **承接它明说的能力差额**。该基线裁定下线全页工作台,退出条件只要求「不退化」,并把「跨 run 浏览 / 云端 run 取回 / 落盘即刷新」整体推给跟进票(§6 R2:「产物页下线有真实能力差额,owner 已接受」)。本稿就是那张跟进票的设计面。 |

### 继承不变的(逐条)

- 卡片行结构:文件名 → 状态 chip → 体积 → 警告计数;圆角、行距、选中态描边全部不动。
- 六态 chip 与配色:`已验证` / `未验证` / `校验不符` / `文件缺失` / `未登记` / `未下载`。
- 预览三页签 `预览 · 源文 · 元数据`,以及「单渲染器崩溃只影响预览区」的隔离合同。
- 「打开前复核」闸门:未过一律不读字节、不出预览;失败诚实呈现、可重试、永不被静默升级成通过。
- Office 结构检查 chip(`结构检查中` / `结构安全` / `已拒绝`)与其「不闪绿」「reduced-motion 停转但文字不变」的呈现纪律。
- 右栏四面板胶囊条、宽度契约、拖拽把手、收起按钮。
- 时间线产物行 → 本面板聚焦该文件、Esc 返回原行。

### 本稿新增的(三件,全部长在既有挂载点上)

1. **云任务条**(唯一新增 CSS 家族)—— 面板顶部一行,替掉现在写死的小标题 `本回合产物`。收起态显示当前是哪一次 + 一枚刷新按钮;展开态就地下推一张列表,列出这个项目的历次云任务。
   形制不是发明:右栏另三个面板本来都有自己的顶条(审查=摘要条 `review-panel.css:26`、终端=页签条 `terminal-rail.css:20`、文件=筛选条 `session-rail-files.css:28`),产物面板是四个里唯一没有的。
2. **单件取回** —— 把全页工作台早已有、右栏当初刻意不接的「未下载 → 下载 → 可预览」动作装回卡片行,复用 `workbench-core.ts` 里那台**已经写好且有单测**的 `downloadReducer`。
3. **新结果落地提示** —— 云任务回流落盘后条上出现一条可点提示 + 刷新按钮上一颗点。不抢焦点、不自动跳走。**这一件依赖一条今天不存在的通道**,见 ④ 裁决 A。

### 明确不继承的一件

下线的全页工作台顶部有一个**项目下拉**。右栏**不恢复它**。右栏的项目由当前会话决定;把项目下拉搬进右栏,等于把 REQ-126 基线裁掉的那个「与当前会话无关的工作面」偷偷装回来。

### 顺带订正的一处真缺陷:`本回合产物` 今天是一句假话

现役小标题 `本回合产物`(`artifacts-panel-view.tsx:118` → `alpha.session.artifactsTurn`)**不是措辞问题,是一个真缺陷**:

- 面板的数据按 **项目目录** 取 —— `window.api.runArtifacts.projectUsage(identity.directory)`(`session-rail-artifacts.tsx:52`),
  返回的是这个**项目**下 `.alpha/runs/*` 的全部 run;
- 面板选的是排序后的第 0 个(`session-rail-artifacts.tsx:59-63`);
- 该 run 完全可能由**同一项目的另一个会话**产生 —— run 目录里没有会话 id,`projectUsage` 也不按会话过滤。

于是界面用**会话级说法**("本回合")罩住了**项目级数据**。用户看到它,会以为「这是我刚才这一轮的产出」。
在同一项目开两个会话、或上一个会话刚跑完一次云任务时,这句话就是错的 —— 而且没有任何东西会提示它错了。

owner 裁决 **D**:这行字**替换**为选中那一次的自述(时刻 + 「最近一次 / 上一次」标记),不保留。
切换器把「现在看的是哪一次」变成用户自己选的,**顺带把这个缺陷消掉**。

**由此定死一条纪律:本面板的任何文案都不得再对项目级数据作会话级断言。**
包括未来给「产物」页签补计数徽标时 —— 那个数同样是项目级的,不能叫「本回合产物数」。

## ② 每个可点的东西对应哪条通道

行号对本工作树(分支 `docs/660-artifacts-cross-run-design`,基线 `98b455ad`)。

### 今天就有,零新通道

| 面板上的东西 | 通道 | 证据 |
| --- | --- | --- |
| 历次云任务列表 | `window.api.runArtifacts.projectUsage(directory)` → `usage.runs[]` | `packages/ui-mac/src/main/artifact-service.ts:1615-1647`(遍历 `.alpha/runs/*` 逐 run 汇总);面板已在调用,只是取了 `sortRunUsages(...)[0]`(`session-rail-artifacts.tsx:59-63`) |
| 每行「N 个产物 · 体积」「N 个缺失」「记录不可读」 | `RunArtifactUsage.artifactCount / diskBytes / missingCount / readOnly` | `artifact-service.ts:1547-1559` |
| 项目用量条 | `usage.totalDiskBytes` / `usage.limits.projectMaxBytes` | `artifact-service.ts:1603-1612`,同一次调用即返回 |
| 换一次后的产物清单 | `runArtifacts.list(directory, runId)` | 已在用(`session-rail-artifacts.tsx:65-76`),换个 `runId` 即可 |
| 「未下载」卡片(平台有、本地无) | `window.api.cloud.artifacts(runId)` → `deriveCards({..., cloudArtifacts})` | `main/cloud-ipc.ts:103` → `main/alpha-cloud-jobs.ts:134-140`;派生函数 `workbench-core.ts:67-84` 早已支持该入参,右栏刻意没喂 |
| 单件下载 / 进度 / 取消 | `cloud.downloadArtifact` · `cloud.onArtifactProgress` · `cloud.cancelArtifactDownload` | `main/cloud-ipc.ts:108-165`;落盘后**自动写回清单**(`cloud-ipc.ts:141-151` → `artifact-service.ts:1070`),故状态从「未下载」变「已验证」不是乐观更新 |
| 下载状态机 | `downloadReducer` / `downloadBusy` | `workbench-core.ts:125-148`,含单测 `workbench-core.test.ts` |
| 打开前复核、预览路由、OOXML 检测 | 现役,一行不改 | `session-rail-artifacts.tsx:123-250` |

两条关键事实:

- **`runId` 就是平台 job id**,同一个字符串直接传给 `cloud.artifacts` / `cloud.downloadArtifact`(`cloud-ipc.ts:132,172-188`;`cloud-run-core.ts:25,34`;run 目录名 `alpha-workdir.ts:232`)。不需要任何映射。
- **整次云任务的回流早就是自动的,而且真的下载字节**。`CloudRunWatcher` 侦测到云任务终态即调 `cloud.saveRun`(`cloud-run-watcher.tsx:37-51`),后者拉平台产物列表并逐件下载落盘、写 `status.json`、写清单(`main/alpha-workdir.ts:224-298`)。所以 AC 里的「取到云端回流的 run」**缺的不是取回动作,是面板知道它发生了**;单件取回补的是回流时**单件失败被降级成 warning** 的那部分(`alpha-workdir.ts:271,276,290,292` —— 零件成功的 run 依然 `ok:true`)。

### 今天没有(本稿不假装它有)

| 想要的东西 | 为什么没有 | 本稿的处置 |
| --- | --- | --- |
| **回流落盘后通知界面** | 渲染进程此前没有任何「run 已保存」推送通道。preload 的 `ipcRenderer.on` 全集里只有 `cloud-artifact-progress` 与 `cloud-job-event`(`preload/index.ts`);watcher 落盘后只 `pushToast`(`cloud-run-watcher.tsx:40-47`),REQ-126 一并退休了 badge 通道(commit `a44c3dec`) | **裁决 A1:新增一条最小推送事件**(只带 `directory` + `runId`)。提示条是已定形态,不是备选。见 ⑦-2 |
| **某次云任务的时间** | `RunArtifactUsage` 全字段无任何时间。盘上其实有(`artifacts.json` 的 `updatedAt`,`main/artifact-manifest.ts:64-69`),但 `runArtifactUsage` 没读、`projectUsage` 没带出来 | **裁决 B1:加一个字段带出来**(不新增 IPC),行上显示真实时刻,排序改为按时间。见 ⑦-3 |
| **某次云任务的成败** | 回流把完整状态写进 run 目录的 `status.json`(`alpha-workdir.ts:252-253`),但**没有任何 IPC 读它** —— 纯只写 | 行上不画成败,写进「不做的」 |
| **标题 / 归属会话 / 云或本地的区分** | 清单与统计里都没有这些字段;云端回流写进的是同一棵 `.alpha/runs/`,与本地 run 在数据上不可分辨 | 行上唯一身份是 `job_…` 短号 |
| **删除 / 清理某次云任务** | 产物 IPC **刻意无写面**:`preload/types.ts:897-898`「下载归 cloud artifact 通道,删除/GC 是 main 内部服务钩子(保留策略未定前不暴露)」 | **裁决:推迟,不属本票**。理由见 ⑤-3;用量条只读 |
| **排序真的按新旧** | `sortRunUsages` 按 `runId` 字典序倒序,注释自陈「job_&lt;hex&gt; 无内嵌时间戳可用;倒序≈新在前」(`workbench-core.ts:154-157`)—— 那是一个**近似,不是设计意图**:编号里没有时间戳,编号生成规则一变顺序就会静默错乱,且没有任何东西会报警 | **随 B1 一并订正为真正按时间排序**。这是修缺陷,不是加功能 |

### 降级路径(必须诚实呈现)

`cloud.artifacts` 需要**登录 + 联网**,失败返回 `{error}` 信封而非抛错(`alpha-cloud-jobs.ts:37-68`,含 `not-authenticated` / `no-cloud-endpoint` / `unauthorized` / `network` / `contract-incompatible`)。取不到时面板**降级为只显示本地产物**并显示现役文案 `平台产物列表不可用(离线或未登录)—— 仅显示本地产物。`,**不假装云端没有东西**。这一条与「单件下载失败」是两件事,稿里并置以证明它们互不掩盖。

### 实现时的一个已知坑

`cancelArtifactDownload` 的 in-flight key 是 `${webContentsId}:${artifact.id}`(`cloud-ipc.ts:119,161-165`),必须传**原始 artifact id**。全页工作台传的是 `card.key`(`artifact-workbench.tsx:288`)—— 对可下载卡片二者相等,但 legacy 卡片的 key 是 `legacy:<savedPath>`。今天 legacy 卡片 `downloadable:false` 所以不可达;右栏接线时**不要沿用 `card.key`**,直接用 `card.descriptor.id` / `downloadPayload.id`。

---

## ③ 实现落点

已并入 **⑦-1「动哪些文件、按什么顺序」** —— 两处各留一份文件清单必然漂移,故此处只留指针。

一条不随位置变的纪律:已批稿的相位判定**失败关闭** —— 没被证明能读的一律显示成加载中 / 出错,
**绝不乐观显示成空**。新增的「这一次没有产物」空态是一个**已证实的空**,与「读不出来」是两回事,不得合并。

---

## ④ 裁决记录(2026-07-28 · owner,全部已定)

上方帧与本文其余部分**已按裁决后的形态**书写,不再有备选分支。

| # | 议题 | 裁决 | 影响 |
| --- | --- | --- | --- |
| A | 回流落盘后面板怎么知道 | **A1 — 加一条最小推送事件**(只带 `directory` + `runId`) | 「结果已落地」提示条是**已定形态**;A2/A3 未采纳 |
| B | 行上要不要有时间 | **B1 — 带出 `artifacts.json.updatedAt`**,并把排序从字典序改为**真正按时间** | 行上显示真实时刻;`sortRunUsages` 的现役近似排序被订正为缺陷修复 |
| C | `manifest 只读` 的措辞 | **采纳** → `记录不可读` | 帧内已按此绘制;i18n 需改 |
| D | `本回合产物` 这行字 | **替换**为选中那一次的自述,不保留 | 顺带消掉 ①「顺带订正的一处真缺陷」记录的假断言 |
| E | run 级管理动作(删除 / 清理) | **推迟,明确不属本票** | 见 ⑤-3 |

### A1 未采纳项的代价(留档,便于日后回看)

- **A2(面板重新可见时重取)**:零新通道,但用户盯着面板不动时结果落地了也不会动 —— 提示条形态得砍掉,
  验收句里的「取到云端回流的 run」只能靠用户主动点。
- **A3(定时轮询)**:反复走磁盘遍历;「几秒」是个凭空的数,依然不准。

### B1 的附带订正

现役 `sortRunUsages` 按 `runId` 字典序倒序,其注释自陈「倒序 ≈ 新在前」。
**这是一个近似,不是设计意图**:`job_<hex>` 里没有时间戳,一旦编号生成规则变化,顺序会**静默错乱**,
而且没有任何测试会因此变红(现役测试 `workbench-core.test.ts:147-148` 恰恰把这个近似锁死成了期望)。
B1 把它从近似换成事实 —— 因此这一条是**修缺陷**,不是加功能,那条现役测试必须被改写(见 ⑦-4)。

---

## ⑤ 不做的(明确划在外面)

也免得日后把本票的关闭读成「这些都做了」。

1. **全页产物页面不以任何形式回来** —— 不新增路由、不新增覆盖层、不做「在新窗口打开」。产物只经会话右栏到达(REQ-126 基线裁决)。
2. **项目选择器不进右栏。** 右栏的项目由当前会话决定。
3. **run 级管理动作(删除 / 清理)不做 —— owner 已裁决推迟,`#660` 的关闭不代表它已交付。**
   票面 Impact 段提到过它,故此处必须写明白。理由三条:
   (a) 产物 IPC **刻意没有写面**(`preload/types.ts:897-898`:保留策略未定前不暴露删除),做它意味着**开一个写面**;
   (b) 随之而来的是不可逆动作确认与误删防护 —— 那是一套自带交互与安全要求的东西;
   (c) 与验收句真正点名的两件事(**在右栏切换历史 run** + **取到云端回流的 run**)是两回事。
   顺带结论:**用量条只能看,不能在这里清。**
4. **行上显示成败不做。** 回流写下的 `status.json` 今天没有任何读取通道,画上去就是编的。
5. **跨次搜索 / 过滤产物不做。** 先解决「能到达」。
6. **预览器本身一行不改。** Office 结构检查(REQ-097/#189、REQ-123/#438)、隔离 HTML 预览、快速查看各归各的交付。
7. **时间线产物行的联动不改。** 它指向当前展示的那一次,切换器落地后仍然如此。
8. **手动触发整次回流不做。** 回流由云任务终态自动发生;给一个「重新回流」按钮既无对应通道,也会让人以为结果需要手动抢救。
9. **不改 `workbench-core` / `renderers/*` 的任何既有渲染行为。** 唯一例外是 `sortRunUsages` 的排序订正(B1),那是修缺陷。

---

## ⑥ 评审后的落库路径

按 `docs/design/README.md` 的两层约定:本文件与其 HTML 是 **dated 提案**(append-only)。owner 最终批准后,把批准形态并入
`current/artifact-workbench/design.html`(或按 PAGE-MAP 第 59 行的归属另立 `current/session-artifacts-rail/`),
并更新 `PAGE-MAP.md` 该行 —— 把「跨 run 浏览、云端 run 取回、落盘即刷新 = 跟进票 #660」改写为已设计/已交付的实际状态,
**同时保留一句「run 级管理动作仍未交付」**,否则日后会有人把 #660 的关闭读成全都做了。
本 dated 稿保持冻结,不回填。

---

## ⑦ 实现计划

**本节只描述做法,不含产品代码。** 行号对本工作树(基线 `98b455ad`)。

### ⑦-1 动哪些文件、按什么顺序

顺序原则:**先让主进程有真事实,再让通道能送,最后渲染端才有东西可读。**
反过来做会逼出一堆假数据占位,而占位最容易留在代码里。

| 序 | 文件 | 做什么 | 为什么在这一步 |
| --- | --- | --- | --- |
| 1 | `packages/ui-mac/src/main/artifact-service.ts` | `RunArtifactUsage` 加 `updatedAt`;`runArtifactUsage` 的**两条**返回路径分别填值 | 时间是 B1 的根,排序与行渲染都依赖它 |
| 2 | `packages/ui-mac/src/main/artifact-service.test.ts` | 补 `updatedAt` 的真值断言与 corrupt 路径断言 | 第 1 步的闸门,先立后用 |
| 3 | `packages/ui-mac/src/main/cloud-ipc.ts` | `cloud-save-run` 成功且镜像完成后,向**全部窗口**广播 `cloud-run-saved` | A1 的发射端 |
| 4 | `packages/ui-mac/src/preload/types.ts` | 加 `CloudRunSavedEvent` 与 `cloud.onRunSaved` 签名 | 契约面 |
| 5 | `packages/ui-mac/src/preload/index.ts` | 按 `onArtifactProgress` 既有范式接线(返回退订函数) | 通道面 |
| 6 | `packages/ui-mac/src/renderer/alpha-ui/artifact-workbench/workbench-core.ts` | `sortRunUsages` 改为按时间倒序,`updatedAt` 缺失时回落编号倒序 | 纯函数,先改先测 |
| 7 | `packages/ui-mac/src/renderer/alpha-ui/artifact-workbench/workbench-core.test.ts` | **改写**锁死字典序的现役用例 | 该用例把缺陷锁成了期望,必须显式改 |
| 8 | `packages/ui-mac/src/renderer/alpha-ui/session-rail/artifacts/artifacts-core.ts` | 加时刻格式化(纯函数,`now` 可注入);相位从「有没有 run」扩到「有没有 run」×「这一次有没有产物」 | 纯值层先落,容器才好接 |
| 9 | 同目录 `artifacts-core.test.ts` | 格式化边界 + 新相位的用例 | 第 8 步的闸门 |
| 10 | `session-rail-artifacts.tsx`(容器) | 选中 run 信号、云端列表合并、下载状态机接线、`onRunSaved` 订阅、刷新动作 | 全部上游就位后一次接通 |
| 11 | `artifacts-panel-view.tsx`(呈现) | 云任务条、展开列表、提示条、卡片行取回动作 | 呈现层最后动 |
| 12 | `session-rail-artifacts.css` | 唯一新增 CSS 家族 `.a-rart-runbar / -runhead / -runsheet / -runlist / -runrow / -runfoot / -newrun` | 只用 `--a-*` token |
| 13 | `renderer/i18n/zh.ts` + `en.ts` | 新增条与两种空态文案;`alpha.wb.runReadOnly` 改「记录不可读」;`alpha.session.artifactsTurn` 退役 | C/D 裁决落地 |
| 14 | `artifacts-test-runtime.tsx` + `session-rail-artifacts.test.ts` | 假通道补 `cloud.artifacts` / `downloadArtifact` / `onRunSaved`;新增行为用例 | 见 ⑦-4 |
| 15 | `docs/design/PAGE-MAP.md`、`CHANGELOG.md` `[Unreleased]` | 第 59 行改写(保留「run 级管理未交付」);用户可见变更入 CHANGELOG | 文档同批,不留尾巴 |

### ⑦-2 新推送事件的确切形状

```
// preload/types.ts
export type CloudRunSavedEvent = { directory: string; runId: string }

// preload/types.ts — cloud 面
onRunSaved: (cb: (e: CloudRunSavedEvent) => void) => () => void
```

- **频道名**:`cloud-run-saved`。
- **发射点**:`main/cloud-ipc.ts` 的 `cloud-save-run` handler 内,**在 `saved.ok` 为真、且 Outputs 镜像步骤跑完之后**
  (`cloud-ipc.ts:172-196`)。镜像之后发,是为了保证收到事件时盘上已经settle,面板重读不会读到半截。
- **广播范围:全部存活窗口**,不是 `e.sender`。这是 A1 相对「渲染端模块信号」的唯一实质理由 ——
  `CloudRunWatcher` 只活在某一个窗口里(`cloud-run-watcher.tsx:23`),而关心这次结果的产物面板可能在**另一个**窗口;
  用渲染端信号会漏掉跨窗口那一半。既有 `cloud-artifact-progress` 用的是单窗口 `wc.send`(`cloud-ipc.ts:134`),
  本事件**刻意不同**,实现时不要照抄那一行。
- **载荷只有两个字段,别的什么都不带。** 不带文件列表、不带字节、不带绝对路径。
  这个事件是**「去重读」的提示**,不是数据源 —— 一旦它开始携带产物列表,就成了第二份会漂移的真相。
  面板收到后仍然走 `projectUsage` / `list` 重新取真相。
- **消费点**:产物面板容器 `session-rail-artifacts.tsx` 在 mount 时订阅、`onCleanup` 退订
  (identity-keyed 重挂已经会杀掉旧订阅,见 `session-rail-artifacts.tsx:26-35`)。
- **过滤**:`e.directory !== identity.directory` 的事件**直接忽略**。
- **收到后的行为**:
  - 落地的 run **不是**当前选中那一次 → 显示提示条 + 刷新按钮上的点(不移焦点、不自动切换);
  - 落地的 run **就是**当前选中那一次 → **静默重取**,不弹提示(用户已经在看它了)。

### ⑦-3 `RunArtifactUsage` 的字段增补与全部调用点

新增字段:`updatedAt: string | null` —— 值取 manifest 里原样写着的那个字符串;**没有可读 manifest 时为 `null`**。

> 刻意不用「读不到就退回目录 mtime」:mtime 是**另一个事实**(最后一次动盘),
> 冒充成「这次任务的时刻」会造出一个永远不会被发现的错值。宁可 `null`,让界面回落到显示编号。

必须改的调用点:

| 文件:行 | 现状 | 要做的 |
| --- | --- | --- |
| `main/artifact-service.ts:1563` `runArtifactUsage` | **两条**返回路径 | corrupt / unsupported-version 路径(`:1570-1582`)返 `updatedAt: null` 且 `readOnly: true`;正常路径(`:1589-1601`)返 `read.manifest?.updatedAt ?? null` |
| `main/artifact-service.ts:1615` `projectArtifactUsage` | 整对象转存(`:1629-1631`) | **代码无需改**,但测试要断言字段确实穿过来了 —— 否则将来有人在这里做投影会静默丢掉它 |
| `preload/types.ts:415` | 只是 re-export | 无需改 |
| `renderer/…/workbench-core.ts:155` `sortRunUsages` | 按 `runId` 字典序倒序 | 改为按 `updatedAt` 倒序;两边任一为 `null` 时对该比较回落编号倒序(保证 corrupt run 既不置顶也不消失,且排序保持确定) |
| `renderer/…/workbench-core.test.ts:147-148` | 断言字典序 | **会变红,且应该变红** —— 改写为按时间断言(见 ⑦-4) |
| `renderer/…/session-rail-artifacts.tsx:62` | 取 `sorted[0].runId` | 改为「默认选 `sorted[0]`,但允许用户选别的」 |
| `renderer/…/artifact-workbench.tsx:124,135` | 已退役的全页组件仍 import `sortRunUsages` | **无需改**(加一个可空字段是源码兼容的),但它仍进 type-check,列出来免得有人以为漏了 |

一个隐藏坑:`workbench-core.test.ts:147` 用 `as RunArtifactUsage` 强制转换构造 fixture,
**类型层不会因为新增字段而报错** —— 也就是说类型系统在这里帮不上忙。改写后的用例应构造真实完整对象,别再用 cast。

### ⑦-4 每个新行为对应哪条会变红的测试

本仓拒收断言源码文本的闸门。以下全部是**纯函数返回值**或**真实挂载后可观察的渲染结果 / 调用序列**。
每条都附「怎么确认它是真闸门」——即把实现改回坏的样子,它是否真的红。

| 新行为 | 测试落点 | 断言什么(可观察) | 怎么确认它不是假闸门 |
| --- | --- | --- | --- |
| 跨次切换真的换了内容 | `session-rail-artifacts.test.ts`,shell harness 假通道给 3 个 run,各自 `list` 返回**不同文件名** | 点了 run B 那一行之后,渲染出的卡片名 = run B 的文件名 | 把选中信号改回写死 `[0]` → 名字仍是 run A → 红 |
| 排序按时间而非编号 | `workbench-core.test.ts` 的 `sortRunUsages` | 返回顺序按时间 | **fixture 必须让编号序与时间序互相矛盾**(如 `job_a` 最新、`job_z` 最旧)。用不矛盾的 fixture 两种实现都过 = 假闸门。保留旧实现 → 返回 `job_z` 在前 → 红 |
| `updatedAt` 真的到得了渲染端 | `artifact-service.test.ts`,临时项目里写一份带已知 `updatedAt` 的 manifest | `projectArtifactUsage` 返回的该 run 的 `updatedAt` **等于写入值** | 任一返回路径漏填 → `undefined` → 红 |
| corrupt manifest 不编造时间 | 同上,写一份不可读 / 版本不支持的 manifest | `updatedAt === null` **且** `readOnly === true` | 改成回落 mtime → 非 null → 红 |
| 推送事件触发重读 | shell harness,假通道记 `projectUsage` 调用次数,并可由测试主动触发一个假 `cloud-run-saved` | 触发**本目录**事件 → 调用次数 +1;触发**别的目录**事件 → 次数不变 | 去掉目录过滤 → 外来事件也重读 → 红 |
| 提示条不抢焦点 | shell harness:先聚焦某张卡片,再触发事件 | `document.activeElement` **不变**,且提示条已在 DOM 里 | 给提示条加 `.focus()` → 红 |
| 提示条只为「别的那一次」出现 | 触发的事件指向**当前选中**那一次 | **没有**提示条渲染,但重读确实发生了 | 无条件显示 → 红 |
| 取回四态渲染诚实 | 既有 `downloadReducer` 用例 + view harness 每态一例 | 四态分别渲染「下载」/ 进度+「取消」/「已验证」/「下载失败」+「重试」 | 把某态映射错 → 对应断言红 |
| 取消不留错误痕迹 | reducer 用例 + view harness | 取消后**没有**错误 chip,动作回到「下载」 | 把 cancel 映射成 error → 红 |
| 云端列表取不到时降级而非隐藏本地 | shell harness,假 `cloud.artifacts` 返回 `{error}` | 本地卡片**仍然渲染**,**且**降级提示同时渲染 | 让合并在出错时返回空列表 → 本地卡片消失 → 红 |
| 换次之后复核闸门仍在字节之前 | shell harness 记录调用序 | `verify` 解析为 ok **之前**没有任何 `read` 调用 | 让预览在闸门前构建 → 调用序断言红 |
| 两种空态可分辨 | view harness | 零 run → **不渲染**云任务条;某次零产物 → 渲染条 + 「这次没有产生文件」 | 两态合并成一个空态 → 红 |
| 界面文案不含内部词 | 对**挂载后渲染文本**做禁词扫描(非源码) | 各相位渲染文本中不出现 `manifest`、`run id` 之类 | 这条断言的是**渲染结果**,重构不会绕过它;把 chip 改回「manifest 只读」→ 红 |

**一条必须显式处理、不能顺手放宽的既有闸门:**
`session-rail-artifacts.test.ts:83` 的「data flows only through the read-only run-artifact channels」
与 `:54` 的 import 白名单棘轮,会因为容器**按设计**新增 `window.api.cloud.*` 用法而变红。
这是架构棘轮不是行为闸门,必须**显式、带理由地**更新白名单(记录:本票经 owner 裁决为容器引入云端读取与下载通道),
**不得**为了让它变绿而把断言改松到无法再挡住下一次越界。

### ⑦-5 没有真实云任务就测不了的部分(不粉饰)

以下几项,单测全绿**不等于**它们被验证过。实现票关闭前应做一次 L1 能力核验,覆盖这五条:

1. **事件在生产里真的会发出来。** 上表全部用假事件测消费端。「`cloud-save-run` 在真实回流后确实广播」
   可以在主进程侧用 stub 掉 `saveCloudRun` 的测试断言 `webContents.send` 收到了正确频道与载荷
   —— 这一层**应该做**,但它 stub 掉了网络,证明的是接线不是端到端。
2. **`cloud.artifacts(runId)` 对真实 run 真的返回平台那份列表。** 需要登录 + 联网。
   测试替身只能覆盖形状(`ok` 与各 `{error}` 变体),覆盖不了「真实端点返回的就是我们假设的结构」。
3. **一次真实的字节下载端到端。** `downloadArtifact` 走流式写入 + 配额收尾 + 下载后写回清单;
   「真下载完之后卡片状态从『未下载』变成『已验证』」只有真件能观察到。
4. **跨窗口广播。** 「窗口 A 保存的 run 让窗口 B 出现提示条」需要两个真窗口;单测 harness 只挂一个。
5. **真实 manifest 里的 `updatedAt` 可解析且格式如预期。** 格式化函数本身是纯函数、可测;
   但「真实回流写下的值确实是可解析的时刻」只有真 run 能确认。
   **缓解:格式化必须失败关闭** —— 解析不出来就回落显示编号,绝不渲染一个错误的时间;这条回落本身是可单测的。

建议在实现票里把上述五条写成一段 L1 核验清单,并明说:**单测绿 ≠ 这五条已验证。**
