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

本文是它的技术面:血统、每个可点的东西对应哪条真实通道、需要 owner 裁决的点、以及明确划在外面的范围。
**评审通过前不进入实现。**

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

### 顺带订正的一处超卖

现役小标题 `本回合产物`(`artifacts-panel-view.tsx:118` → `alpha.session.artifactsTurn`)是一句**不成立的断言**:面板的数据是按 `identity.directory` 取的项目级统计,选的是排序后的第 0 个 run,它完全可能来自同一项目的**另一个会话**。切换器落地后这行字必须换成「当前选中的是哪一次」。

---

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
| **回流落盘后通知界面** | 渲染进程没有任何「run 已保存」推送通道。preload 的 `ipcRenderer.on` 全集里只有 `cloud-artifact-progress` 与 `cloud-job-event`(`preload/index.ts`);watcher 落盘后只 `pushToast`(`cloud-run-watcher.tsx:40-47`),REQ-126 一并退休了 badge 通道(commit `a44c3dec`) | 画成提示条,但**列为裁决 A**;若 owner 选 A2,提示条形态删除,只留手动刷新按钮 |
| **某次云任务的时间** | `RunArtifactUsage` 全字段无任何时间。盘上其实有(`artifacts.json` 的 `updatedAt`,`main/artifact-manifest.ts:64-69`),但 `runArtifactUsage` 没读、`projectUsage` 没带出来 | 稿内**行上不画时间**;列为裁决 B |
| **某次云任务的成败** | 回流把完整状态写进 run 目录的 `status.json`(`alpha-workdir.ts:252-253`),但**没有任何 IPC 读它** —— 纯只写 | 行上不画成败,写进「不做的」 |
| **标题 / 归属会话 / 云或本地的区分** | 清单与统计里都没有这些字段;云端回流写进的是同一棵 `.alpha/runs/`,与本地 run 在数据上不可分辨 | 行上唯一身份是 `job_…` 短号 |
| **删除 / 清理某次云任务** | 产物 IPC **刻意无写面**:`preload/types.ts:897-898`「下载归 cloud artifact 通道,删除/GC 是 main 内部服务钩子(保留策略未定前不暴露)」 | 整体划出范围;用量条只读 |
| **排序真的按新旧** | `sortRunUsages` 按 `runId` 字典序倒序,注释自陈「job_&lt;hex&gt; 无内嵌时间戳可用;倒序≈新在前」(`workbench-core.ts:154-157`) | 只给第一行挂「最近一次」、第二行「上一次」,**再往下不排名次**;真排序随裁决 B 一起解决 |

### 降级路径(必须诚实呈现)

`cloud.artifacts` 需要**登录 + 联网**,失败返回 `{error}` 信封而非抛错(`alpha-cloud-jobs.ts:37-68`,含 `not-authenticated` / `no-cloud-endpoint` / `unauthorized` / `network` / `contract-incompatible`)。取不到时面板**降级为只显示本地产物**并显示现役文案 `平台产物列表不可用(离线或未登录)—— 仅显示本地产物。`,**不假装云端没有东西**。这一条与「单件下载失败」是两件事,稿里并置以证明它们互不掩盖。

### 实现时的一个已知坑

`cancelArtifactDownload` 的 in-flight key 是 `${webContentsId}:${artifact.id}`(`cloud-ipc.ts:119,161-165`),必须传**原始 artifact id**。全页工作台传的是 `card.key`(`artifact-workbench.tsx:288`)—— 对可下载卡片二者相等,但 legacy 卡片的 key 是 `legacy:<savedPath>`。今天 legacy 卡片 `downloadable:false` 所以不可达;右栏接线时**不要沿用 `card.key`**,直接用 `card.descriptor.id` / `downloadPayload.id`。

---

## ③ 建议的实现落点(供实现票切分参考,非本稿裁决内容)

| 落点 | 文件 | 性质 |
| --- | --- | --- |
| 选中 run 的状态与切换 | `session-rail-artifacts.tsx`(容器) | 把 `runId` 从 `createMemo(...[0])` 改成可写信号,默认仍是第 0 个 |
| 云端列表合并 | 同上,`deriveCards` 入参加 `cloudArtifacts` | 通道已在,`deriveCards` 已支持 |
| 下载状态机接线 | 同上,复用 `workbench-core` 的 reducer + `cloud.onArtifactProgress` 订阅 | 零新逻辑 |
| 云任务条与展开列表 | `artifacts-panel-view.tsx` + `session-rail-artifacts.css` | 唯一新增 CSS 家族;建议类名 `.a-rart-runbar / -runhead / -runsheet / -runlist / -runrow / -runfoot / -newrun` |
| 纯值逻辑 | `artifacts-core.ts` | 相位派生需从「有没有 run」扩到「有没有 run」×「这一次有没有产物」两态 |
| 文案 | `i18n/zh.ts` + `en.ts` | 新增云任务条与两种空态文案;订正 `alpha.wb.runReadOnly`(见裁决 C) |

已批稿的相位判定纪律不变:**失败关闭** —— 没被证明能读的一律显示成加载中/出错,绝不乐观显示成空。

---

## ④ 待 owner 裁决

### A · 云任务结果落地后,面板怎么知道

今天没有任何「已保存」推送到界面(证据见 ②)。三条路:

- **A1(稿内推荐)· 加一条最小推送通道。** 回流落盘成功后主进程推一条只带项目目录与任务编号的事件;面板收到即显示提示条。一条通道、一个事件、零轮询,提示与事实严格同步。代价:新增一个 IPC 通道并在契约里登记。
- **A2 · 面板重新可见 / 窗口重新聚焦时自己重取。** 零新通道。但用户盯着面板不动时结果落地了也不会动 —— 那么**提示条这个形态就得砍掉**,退回「手动刷新按钮」一件,AC 里的「能取到云端回流的 run」只靠用户主动点。
- **A3 · 定时轮询。** 不推荐:反复走磁盘遍历,且「几秒」是个凭空的数,依然不准。

**A 的选择直接决定稿里第三组帧(结果落地提示)保留还是删除。**

### B · 行上要不要有时间

- **B1(稿内推荐)· 把已有的时间带出来。** `artifacts.json` 里本来就有 `updatedAt`;在 `RunArtifactUsage` 上加一个字段、在 `runArtifactUsage` 里填上它(`artifact-service.ts:1547 / 1563`),行上就能显示人能读的时刻,排序也能从字典序改成**真正按时间**。不新增 IPC,改动集中在一处结构与其填充。
- **B2 · 就按本稿画的来,只有短号。** 零改动、绝对诚实,但用户要靠 `job_…` 认「哪一次是我要的那次」,且排序永远只是**近似**按新旧。

### C · `manifest 只读` 这枚 chip 的措辞

现役文案 `alpha.wb.runReadOnly` = `manifest 只读` —— 内部词上了界面,违反本仓「帧内不出现开发行话」的纪律。本稿改为 **`记录不可读`**。若 owner 另有偏好说法,在这里定,一并改掉。

### D(顺带确认)· 「本回合产物」这行字换成什么

切换器落地后小标题被云任务条替代。请确认「用当前选中那一次的名字(最近一次 / 上一次 / `job_…`)」这个方向可以,而不是保留一个仍然叫「本回合」的标题。

---

## ⑤ 不做的(明确划在外面)

1. **全页产物页面不以任何形式回来** —— 不新增路由、不新增覆盖层、不做「在新窗口打开」。产物只经会话右栏到达(REQ-126 基线裁决)。
2. **项目选择器不进右栏。** 右栏的项目由当前会话决定。
3. **删除 / 清理某次云任务不做。** 产物通道刻意没有写面;这也意味着用量条只能看,不能在这里清。
4. **行上显示成败不做。** `status.json` 今天没有任何读取通道,画上去就是编的。
5. **跨次搜索 / 过滤产物不做。** 先解决「能到达」。
6. **预览器本身一行不改。** Office 结构检查(REQ-097/#189、REQ-123/#438)、隔离 HTML 预览、快速查看各归各的交付。
7. **时间线产物行的联动不改。** 它指向当前展示的那一次,切换器落地后仍然如此。
8. **手动触发整次回流不做。** 回流由云任务终态自动发生;给一个「重新回流」按钮既无对应通道,也会让人以为结果需要手动抢救。
9. **不改 `workbench-core` / `renderers/*` 的任何既有行为。** 本稿只是把右栏当初没接的入参与状态机接上。

---

## ⑥ 评审后的落库路径

按 `docs/design/README.md` 的两层约定:本文件与其 HTML 是**dated 提案**(append-only)。owner 批准后,把批准形态并入
`current/artifact-workbench/design.html`(或按 PAGE-MAP 第 59 行的归属另立 `current/session-artifacts-rail/`),
并更新 `PAGE-MAP.md` 该行 —— 把「跨 run 浏览、云端 run 取回、落盘即刷新 = 跟进票 #660」改写为已设计/已交付的实际状态。
本 dated 稿保持冻结,不回填。
