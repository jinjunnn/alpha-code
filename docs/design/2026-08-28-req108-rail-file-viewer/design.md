---
type: design
slug: req108-rail-file-viewer
date: 2026-08-28
status: proposed
relates:
  - jinjunnn/alpha-code#244(REQ-108,本增量是其 Ready 门;原 #1162 已并回本票身份)
  - jinjunnn/alpha-code#245(子票:本地 descriptor + 入口接线)
  - jinjunnn/alpha-code#246(子票:html 隔离 host 的右栏 placement 合流)
  - jinjunnn/alpha-code#296(PDF.js 隔离 worker —— 本稿依据实测建议其前提作废,见 §5)
  - jinjunnn/alpha-code#1164(Office 提取视图,占位文案的最终取代方)
---

# 右栏文件查看器 —— 文件面下钻 + html/pdf 就地预览 + 诚实态

> 帧见同目录 [`frame.html`](frame.html)(查看器九态 + 入口分流表 + 诚实标示与
> 占位文案 + 交互契约,浅/深色)。批准后的并入落点见 §8;台账行见
> [`current/session-workspace/components.md`](../current/session-workspace/components.md)、
> [`current/artifact-workbench/components.md`](../current/artifact-workbench/components.md)、
> [`current/conversation-timeline/components.md`](../current/conversation-timeline/components.md)。

## 1. 与上一稿的关系

**继承**:

- 右栏四面板骨架、文件面板的树 / 过滤 / 「已打开」组、类别标与「带标行 → 审查」
  分流 —— session-workspace 现行稿 `#files` / `#railsec`,零改动;
- 诚实卡片语言(「怎么回事 + 现在怎么办」两段式、未知值 mono 原样、fail-closed
  不留白屏)—— artifact-workbench 现行稿与 req090 的失败卡骨架;
- 产物链接行的形态(一行一链接、无卡片无缩略图)与「右栏如实回答」原则 ——
  conversation-timeline 现行稿 §⑥(2026-07-21 已批增量);
- html 隔离预览的全部安全判据(≤32MB、sibling 仅图片/字体、外链 403、零外网、
  无 preload、并发上限、被拦清单口径)—— 既有实现与其测试,本稿一条不放宽。

**新增**:文件查看器(文件面板的下钻层)—— 头部合同、Markdown 预览|源码、
读取中/取消、四种失败态;html 与 pdf 的**右栏内**呈现形态(隔离内容区)。

**取代**:

- 「文件树点击 → 写入无消费者的打开列表」的现状行为(它不是已批设计,是悬空
  实现 —— 见 §2);
- conversation-timeline §⑥ 帧注中「可预览标示」的派生方式:从「路由命中即标」
  改为「注册表内联标注」单一权威(§6);
- artifact-workbench Office 占位的将来时文案(§7);
- html 预览「开在独立窗口」的 placement(host 本体与判据不变,只动放哪)。

## 2. 动笔前的地面真相(本轮勘破实读,坐标皆现行 alpha 分支)

| 事实 | 坐标 |
| --- | --- |
| 文件树点击**绑了也执行了**,但 `openedTabs.open` 写入的 tab store 在 alpha-ui 零消费者 —— 「打开」是悬空引用 | `files-view.tsx:109` → `files-state.ts:239-246` → `session-rail-files.tsx:74-79`;消费者检索仅命中 files 面板自身 |
| 文件内容读取通路已存在且上游在用 | 引擎 `GET /file/content`(`file.ts:148-157`);`client.file.read({path})` 消费者 `packages/app/src/context/file.tsx:184`、`review-tab.tsx:57` |
| renderer 注册表 9 个 id,md/json/csv/image/code/text 内联真预览;pdf 到站是诚实卡;html 到站开独立窗口 | `renderers/registry.ts:175-186`、`renderer-views.tsx`(RENDERER_COMPONENTS) |
| html 隔离 host:一次性独立窗口 + session 级自定义协议 + 全 deny(无 preload、零外网、下载拦截),32MB 预算,被拦清单口径已定 | `main/html-preview-host.ts`、`shared/html-preview.ts`、`ArtifactHtmlPreview.tsx` |
| Electron 42.3.3 自带完整 Chromium PDF viewer:`plugins:true` 即可,三臂对照实测(坏文件 frames=0 / 空基线 / 真 PDF frames≥1 + 截图确认工具栏、缩略图、正文) | 2026-08-28 主 session spike(方法与截图存证于该轮记录);渲染在独立子 frame,主文档 DOM 为空 —— DOM 探针结构性看不见它 |
| pdf 链接行今天被标「可预览」样式,点开却是「尚未提供」卡片 | `tool-cards.tsx:979`(`rendererId !== "fallback"`)、`cards.css:1243-1252`、`zh.ts:885` |
| Office 占位用将来时承诺未排期功能 | `renderer-views.tsx:676-681`、`zh.ts:914-915`(「提取的文字与表格将在这里呈现…」) |
| 「PDF 独立 worker 已在役」的既有记载与地面真相不符 | ADR-032 PDF 行;#296 自 2026-07-14 起 Triaged 零 PR —— 落地时按文档标准修订 ADR |

## 3. 信息架构:查看器是文件面板的下钻层

- **不是第五个 tab,不是新面板。** 文件 tab 保持激活,面板主体从树切到内容,
  返回箭头 / Esc 回到树(树的滚动与展开状态保留)。四面板骨架不动。
- **右栏内本地文件的预览面只有这一块**(#244 AC1 的「唯一 preview surface」):
  - 文件树无改动标的行 → 查看器;
  - 文件树带改动标的行 → 审查面板文件卡(沿用既定分流:改动优先看 diff);
  - 时间线写入/编辑文件卡 → 审查面板;审查文件卡头部新增「查看整份文件」动作
    → 查看器。**注**:#244 AC1 原文写文件卡「直接」打开 preview surface,它写于
    审查面恒空缺陷定位之前;审查面修复(REQ-142)后,「变更卡直达查看器」会与
    「改动优先看 diff」打架。本稿把 AC1 解释为**一跳可达**(卡 → 审查 → 查看整份
    文件),此解释请 owner 在批稿时一并裁决。
  - 产物面板预览列服务云端任务产物(不同数据域),保持现有形态;其 html/pdf
    单元复用 §4 的同一块隔离内容区语言,不构成第二套预览。
- 查看器渲染复用 registry 现有组件(markdown/code/csv/json/image/text),
  Markdown 默认预览、可切源码(#244 AC2);数据经本地 descriptor 服务
  (main 侧 realpath/symlink/size/range 校验,#245 域),不喂裸路径。

## 4. 载体裁决:隔离内容区 = WebContentsView 叠放(html 与 pdf 共用)

**选型**:html 与 pdf 的内容区用主进程持有的 WebContentsView,按查看器内容区的
bounds 叠放在右栏上;html 复用既有隔离 host 的同一 session、同一自定义协议、
同一全 deny 组(改的只是「画在哪」,不是「怎么隔离」)。文本类格式(md/code/
csv/json/image)不经此载体,仍是普通 DOM 组件。

**为什么不是别的**:

| 候选 | 为什么否 |
| --- | --- |
| iframe(renderer 内嵌) | 预览内容进主 renderer 的进程与 CSP 域,较之今天的独立 window + 独立 session 是**隔离降级** —— 直接违反 #244 AC3「placement 变化不削弱零网络/零 bridge/短生命周期」 |
| `<webview>` 标签 | 需全局开 `webviewTag`,给主 renderer 增加常驻攻击面;Electron 官方文档明示不推荐。换取的唯一好处(DOM 里有元素)对证据帮助有限 —— 内容仍在 guest 进程,DOM 断言照样看不到内容 |
| 沿用独立窗口 + 只改唤起方式 | 不满足「在右栏内呈现」的产品目标;#246 票面自书 placement 合流,host 不必重建 |

**AC3 论证(placement 变了,隔离没降)**:窗口形态与 view 形态共用同一
session/协议/deny 链路,隔离判据的断言值一条不改(证据 = 既有隔离测试字面量
diff 核对 + 全绿);view 无 preload、无 IPC 桥,与今天的窗口相同;生命周期收紧
(见下),没有放宽项。

**短生命周期与遮挡合同**(帧内「交互契约」表的设计依据):

- 创建:进入 html/pdf 状态时;销毁(destroy,不是 hide):返回树、切文件、
  切面板、收起右栏、切会话、窗口关闭 —— 与 AC5 的读取终止五条路同一张表;
- 强模态(权限确认等)出现 → view 隐藏,模态关闭 → 恢复;模态永远不被叠放层
  遮挡。这是叠放载体的固有代价,必须作为显式合同交给实现与验证;
- 拖宽 / 窗口 resize → bounds 同步跟随内容区。

**证据形态的后果**(写给 VERIFY):叠放载体在主文档 DOM 里没有节点 ——
placement 与内容的判据必须用主进程状态断言(view 存在性 / bounds / 所属
session)+ 截图 + (pdf)渲染 frame 计数 ≥1;**不用 DOM 探针**。DOM 断言只对
查看器 chrome(头部、状态行、失败卡)与文本类内容有效。pdf 判据先以已知的坏
自证(坏文件 frames=0 / 空基线 / 真 PDF frames≥1),沿用 spike 的三臂方法。

## 5. PDF:内置查看器,不再走 PDF.js 路线

- 平台能力已实测成立(§2):Electron 42.3.3 自带完整 Chromium PDF viewer。
  #296(PDF.js 隔离 worker)的前提「仓内零 pdf 渲染能力」在平台层不成立,
  建议随实现落地关闭或改写该票;ADR-032 的 PDF 载体行同步修订。
- `plugins: true` 只开在这个 WebContentsView 的 webPreferences 上,主窗口与其余
  面不动 —— 开启范围最小化。
- 内容经 descriptor 门控的自定义协议供给(与 html 同一形态),不喂裸 `file://`
  路径 —— 维持 #244「不暴露路径」的设计要点,pdf 的读取同样受 workspace 圈禁。
- **viewer 自带下载 / 打印按钮的处置(请 owner 裁决,二选一)**:
  - **推荐:放行但收口** —— `will-download` 一律路由到系统保存对话框,目标由用户
    亲选。它下载的是用户 workspace 里自己文件的副本,与 html host「全 deny 下载」
    针对的威胁(网页内容诱导下载外来物)不同类;且 #244 AC6 本就把「另存副本」
    列为诚实动作。打印同理放行(只读升级,走系统打印对话框)。
  - 备选:与 html 纪律完全对齐,`will-download` 全拦。代价:viewer 工具栏上有一个
    永远无声失败的按钮(Chromium 工具栏不可定制),与本稿的诚实性原则冲突 ——
    所以不推荐,但它更保守。

## 6. 诚实标示:一个权威回答「右栏里能不能直接看到内容」

- 时间线产物链接行的强调/中性标示,派生自 **renderer 注册表的「内联呈现」标注**
  (单一权威),不再用「路由命中非 fallback」推断。行形态不变(已批 §⑥ 合同:
  行本身同形,颜色回答能不能就地看到内容)。
- 就地预览落地后的期望标注:md/json/csv/image/code/text/html/pdf = 内联(强调),
  fallback(含 office、parquet 类)= 非内联(中性);office 在提取视图落地时翻为
  内联 —— 届时只改注册表标注一处,行、到站、测试同步翻转。
- 测试纪律(写给实现票):对注册表每个 id 逐一断言「标示 = 到站行为」,右侧
  必须是该 id 组件对样本的**渲染产物**(内容出现 / 诚实卡出现),禁止右侧也从
  标注读出(标注对标注恒真)。

## 7. Office 占位:现在时,只说做得到的

- 新文案(帧内为准):标题「已通过结构检查」,正文「原件未被修改。可用『快速
  查看』浏览完整文档,或在系统应用中打开。」
- 取代 zh/en(及 zht)对应键的将来时句(「提取的文字与表格将在这里呈现;排版
  可能与原件不同」)。「排版可能与原件不同」这句话跟提取视图走 —— 提取视图
  落地时由其自己的稿承载,不留在占位里。
- 提取视图落地后,整个占位块被其取代;本条以「占位面不再存在」自然闭合。

## 8. 批准后的并入落点(一稿三页,各取所属)

| 内容 | 并入 | 锚 |
| --- | --- | --- |
| 查看器九态帧 + 头部合同 + 入口分流 + 读取/终止合同 | `current/session-workspace/design.html` 的 `#files` 节(其后新增查看器小节) | 并入时铸 `#file-viewer` |
| 隔离内容区(html/pdf 就地)形态与遮挡合同 | 同上(查看器小节内);产物面板预览列的采用以一句注记并入 `current/conversation-timeline/design.html` §⑥ 的预览面说明 | `#file-viewer` / `#artifacts` |
| 链接行标示权威的修订 | `current/conversation-timeline/design.html` §⑥ 帧注 | `#artifacts` |
| Office 占位新文案 | `current/artifact-workbench/design.html` `#switcher` 帧内文案 | `#switcher` |

## 9. 本稿不做的

- 时间线媒体行(无 id 的联动死胡同)—— 另立票;
- workspace 文件进产物 manifest 体系(REQ-108 之外的全量);
- Office 内容渲染(提取视图,独立交付);
- 大文本虚拟化(独立票域,本稿只定「过大 → 节选」的形态与文案骨架,阈值由
  实现契约钉,帧内 412 MB / 8 MB 类数字均为演示值);
- Windows 面的快速查看对应物;
- 产物面板自身的信息架构(云任务列 / 卡片列 / 预览列,照旧)。

## 10. 请 owner 随批稿一并裁决的三件事

1. §3 对 #244 AC1 的「一跳可达」解释(时间线文件卡经审查到查看器);
2. §5 PDF viewer 下载/打印的处置(推荐:放行但收口到系统保存对话框);
3. §4 载体 = WebContentsView 叠放(含遮挡合同与证据形态的代价)。
