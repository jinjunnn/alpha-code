---
id: REQ-095
title: 核心 Artifact Renderer 套件 —— 常用格式确定路由、安全预览、fallback 与恶意 fixture
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/207
repo: A
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10);用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

当前产品主要能显示会话 Markdown、代码/文本和少量附件，没有统一 Artifact Registry，也没有对 JSON、CSV、PDF、媒体等 run artifacts 的确定 renderer/fallback。格式判断分散后容易仅凭扩展名执行错误路径；超大、损坏或恶意文件也可能卡死主 renderer。

本需求提供“常用、安全、只读”的核心 renderer 层；Office OOXML 的结构验证和高保真 derivative 由 [[REQ-097]] 单独负责，HTML 则因权限域不同由 [[REQ-096]] 隔离。

## 目标与交付

1. 建立 declarative `ArtifactRendererRegistry`：按 `detectedMime`、magic/container subtype、trust、size、capability 和 priority 匹配；选择结果可解释，未匹配时稳定回退 Source/Metadata/保存副本/系统外部打开。
2. 首批内置 renderer 覆盖：Markdown、plain text、code、JSON、CSV/TSV、raster image、SVG、audio、video、PDF。
3. 各格式基线：
   - text/code：增量/range 读取和虚拟化，编码/BOM/二进制误判可诊断，不执行代码；
   - Markdown：继续严格净化，Preview/Source 双模式，远程图片默认阻止并由用户点击加载；
   - JSON：安全解析、折叠树与 Source；不解释原型键为对象行为；
   - CSV/TSV：内部 cell model + 虚拟表格，公式字符串只展示、不执行；
   - image：受控 blob/custom protocol，限制文件字节、解码像素、帧数和内存；
   - SVG：净化脚本、事件、外链、foreignObject 与递归资源，不能继承主页面权限；
   - audio/video：原生 media + range stream，显示 codec 不支持 fallback，不自动播放；
   - PDF：PDF.js 独立 worker，禁 PDF JavaScript、launch action、自动外链和自动表单提交。
4. renderer 只通过 [[REQ-093]] source/descriptor 获取受控 range/stream，不读任意 renderer-provided path，不把完整字节放进 Solid store 或 IPC。
5. 所有 renderer 受统一 ErrorBoundary、取消、超时、大小/复杂度预算和资源释放协议管理；切换 artifact 后释放 object URL、worker、media stream 和缓存。
6. 为每种格式维护 golden/fixture corpus，并将正常、损坏、扩展/MIME 不符、超大、恶意五类作为 CI 固定矩阵。

## 可验证验收标准

1. 十类格式均能从 [[REQ-094]] Workbench 打开；Registry 日志/Metadata 明确显示选中的 renderer 和原因。未知格式、损坏文件或 renderer crash 均可退回 Source/Metadata/外部打开，不影响 Session。
2. 每类至少具备五种 fixture：正常、损坏、扩展/MIME 冲突、超限、恶意；共至少 50 个用例进入自动测试，且恶意 fixture 不产生网络、脚本执行、文件读取或主 renderer 导航。
3. 100 MiB text/CSV 和长 JSON 在打开时不构造完整 DOM；首屏可交互时间与内存基线有记录，滚动采用 range/virtualization，取消后不继续后台解析。
4. Markdown 追踪图默认不发出请求；SVG 的 script/event/external resource/foreignObject fixture 被移除或拒绝；CSV `=CMD(...)`/`=HYPERLINK(...)` 只作为文本显示。
5. PDF JavaScript、launch action、外链、嵌入文件和损坏 xref fixture 不执行动作；用户点击外链须经 Alpha 明示确认并交由系统策略处理。
6. image 解压炸弹/超大像素、动画帧爆炸、媒体 codec 不支持均给出可恢复错误；不会冻结主 renderer 或持续占用资源。
7. renderer contract 测试证明只消费 descriptor/range stream；Electron IPC 与 UI store 中不出现完整 base64/ArrayBuffer。
8. 键盘、屏幕阅读器名称、缩放、文本复制、色彩对比和 reduced motion 通过 Workbench 可访问性回归基线。

## 非目标

- 不在主 renderer 直接执行任意 HTML、SVG script、PDF JavaScript、Office macro、CSV formula 或 artifact 内代码。
- 不承诺所有音视频 codec；不支持时提供系统外部打开/保存副本。
- 不提供 DOCX/XLSX/PPTX 权威高保真渲染；归 [[REQ-097]]。
- 不实现通用浏览器或网页交互；归 [[REQ-106]]。
- 不为第三方 renderer 开放顶级页面、任意 preload 或 Node 权限；第三方 contribution 另受 capability/policy 治理。

## 依赖与激活条件

- 依赖 [[REQ-094]] 的 Workbench host；字节与身份契约由 [[REQ-092]]、[[REQ-093]] 提供。
- 复用现有代码/markdown/diff viewer 时必须经过 Alpha typed adapter，遵守 [[ADR-016]] 与 [[ADR-020]]。
- [[REQ-097]] 依赖本需求提供 PDF/image derivative renderer 和 fallback；[[REQ-096]] 与本需求共享 host contract，但安全进程必须独立。
