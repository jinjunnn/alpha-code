---
id: REQ-097
title: Office 产物预览与验证链 —— OOXML reopen、ZIP bomb 防护、golden corpus 和 PDF/PNG derivative
type: feature
github_issue: https://github.com/jinjunnn/alpha-work/issues/3
repo: X
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10)+Office MCP 供应链复核;用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

当前 Office pipeline 让模型生成 Python，调用 `python-docx`/`python-pptx`/`openpyxl` 后只按进程退出 0 回收单一文件。B 仓 `packages/gateway/Dockerfile` 没有 LibreOffice、Chromium 或 Office renderer，因此 ZIP 损坏、空文档、字体替换、文字溢出、公式错误和 Office 无法打开都可能被当作成功。

[[REQ-080]] 解决的是 Office 写作 MCP/引导技能上架，不证明 DOCX/XLSX/PPTX 能在 Alpha 内正确渲染；其中 Word/PPT 上游随后归档也说明生成供应与产品验证不能混为一件事。本需求建立 Alpha 自己持有的结构验证、视觉 derivative 和跨平台 corpus。

## 目标与交付

1. 对 DOCX/XLSX/PPTX primary 生成后强制 reopen：先验证 ZIP/OOXML 容器，再用对应独立读取路径重新打开，检查必需 content type、relationship、part、CRC 和基本文档结构；不能仅凭生成进程退出码判成功。
2. ZIP 防护默认拒绝路径穿越、绝对路径、symlink、加密 entry、递归压缩包和未声明危险 part；限制 entry 数、解压总量、单 entry 与压缩比。默认上限：10,000 entries、512 MiB 解压总量、100:1 压缩比，且受 [[REQ-093]] 外层 artifact quota 约束。
3. 格式专项结构检查：
   - DOCX：主 document、relationships、section/paragraph/table/media 引用可解析；
   - PPTX：presentation、slide 列表、layout/master/media 关系完整且至少一页可读；
   - XLSX：workbook、worksheet/shared strings/styles 关系完整，维度/合并单元格/公式记录可读；公式只展示，不在 Alpha 中执行。
4. 在禁网、限时、限内存、限进程的隔离 converter worker 中生成 derivative；LibreOffice/其他 converter 不得进入 Electron main process。输出至少包括 primary、PDF preview、PNG page/slide thumbnails 和 `verification.json`，并通过 [[REQ-093]] role/primaryId/previewIds 关联。
5. 建立经过许可审查的 golden corpus：普通、复杂布局、表格/图表、图片、CJK/RTL/emoji、缺字体、大页数/大工作簿、损坏、恶意 OOXML。保存结构预期、页数/slide/sheet 数和允许的视觉差异阈值。
6. 建立 macOS、Windows、cloud Linux 的 smoke/视觉矩阵；明确 converter/version/font 包，字体缺失必须产生 warning，不能把不可比结果标为 render passed。
7. Workbench 显示 Structure/Render 两类状态、warning、converter/version 和 derivative 来源；结构失败不启动 converter，高保真失败仍允许 Source/Metadata/保存 primary，不能伪装成功。

## 可验证验收标准

1. 每个格式至少 10 个 golden 文件，正常 corpus 全部 reopen；manifest 中结构、页/slide/sheet 计数、sha256 和 derivative 关系稳定，应用重启后可恢复。
2. truncated ZIP、CRC 错、缺关键 part、关系悬挂、路径穿越、10,001 entries、超 512 MiB 解压量、超 100:1 压缩比与嵌套压缩 fixture 全部在转换前拒绝，且不发生目录逃逸或资源耗尽。
3. converter 在无网络、固定 wall-clock/内存/进程上限下运行；超时、OOM、崩溃不影响 gateway/Electron 主进程，错误写入 `verification.json` 并可重试。
4. DOCX/PPTX/XLSX 均产生可由 [[REQ-095]] 打开的 PDF/PNG derivative 与 thumbnail；primary 仍可保存/外部打开。空白或零页 derivative 不得标记 render passed。
5. golden corpus 在 macOS、Windows、cloud Linux 至少各跑一次 smoke；关键文档执行 PDF/PNG 像素或结构化视觉 diff，阈值、基线更新理由和 converter/font 版本进入审计记录。
6. 字体替换、文字溢出、裁切、公式无缓存值、图表/媒体丢失等无法自动证明正确的情况显示 warning/needs-review，不把“转换成功”冒充“视觉正确”。
7. Office bytes 不经 base64 进入 status/MCP/result/IPC；primary 与 derivative 全部使用 [[REQ-092]] 流式传输和 [[REQ-093]] quota/provenance。
8. 验证报告 schema、失败分类和至少前一版本 migration 有 contract tests；A/B 对同一 verification 状态的 UI 呈现一致。

## 非目标

- 不在 Alpha 内实现 Office 编辑器、宏执行、ActiveX、外部数据连接或公式计算引擎。
- 不承诺与所有 Microsoft Office 版本像素级一致；目标是结构可打开、确定 derivative、已知差异 loud 和可人工复核。
- 不把 archived/社区 Office MCP 视为验证根；任意 generator 都必须经过同一 Alpha-owned validation pipeline。
- 不在 Electron main process 安装/运行 LibreOffice 或无资源边界的 converter。

## 依赖与激活条件

- 依赖 [[REQ-093]] descriptor/manifest/provenance、[[REQ-094]] Workbench 状态面与 [[REQ-095]] PDF/image renderer；传输依赖 [[REQ-092]]。
- 与 [[REQ-080]] 的生成/连接器供给解耦：可用固定 OOXML corpus 独立开发；任一新 generator 上架前须接入本验证链。
- converter 与字体许可、再分发、SBOM 和跨平台安装成本通过供应链审查后，才可进入 packaged 默认路径。
