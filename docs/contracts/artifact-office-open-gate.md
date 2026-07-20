---
title: Artifact Office external-open gate
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2026-10-20
---

# Artifact Office 外部打开闸契约

本文钉住 REQ-093 #281 的 Office 外部打开边界。renderer 只能把检测结果当路由提示；main
必须从受管 artifact 身份重新定位、固定并复制字节，再独立执行同一份严格 ZIP/OOXML
检测。只有结构、扩展名与非中性 MIME 一致的非宏 `.docx`、`.xlsx`、`.pptx` 可以交给
外部 Office；其余命中本契约的格式一律 fail-closed，不做宏语义扫描，不扩大内置预览面。

## 1. zip.js fallback 单次未检查阶段的内存上界

锁定依据是当前解析版本 `@zip.js/zip.js@2.7.62` 的发布源码。`I = 16,384` 是配置的压缩
输入块，`D = (I + 1) × 1,032 = 16,909,320` 是一次同步 `append` 最多交付的逻辑膨胀，
`B = 2I = 32,768` 是 fallback 的 reusable output buffer，`W = 2^15 = 32,768` 是独立
sliding window。

| 项 | 保守计入 | zip.js 源码依据 |
| --- | ---: | --- |
| 压缩输入分块与重组 | `6I = 98,304` | `lib/core/io.js:72-82` 以 `chunkSize` 读取，`:522-524` 用 `slice` 复制；`lib/core/streams/codec-stream.js:125-150` 可同时留下两个输入块、一个 `2I` 合并块及两个 `I` 切片。 |
| 单次逻辑膨胀 | `D = 16,909,320` | `lib/core/streams/codecs/inflate.js:105-110` 把最大 copy length 定为 258，`:486-489` 再确认最大串长及最长 length/distance pair；边界按 DEFLATE 的 1,032:1 极值并多计一个 append-boundary 输入字节。 |
| fragments payload | `D = 16,909,320` | `inflate.js:2112-2139` 建立 `buffers` 并复制满 output buffer，累计 `bufferSize`。 |
| fragments 合并副本 | `D = 16,909,320` | `inflate.js:2145-2152` 另建 `Uint8Array(bufferSize)`（单 fragment 分支也复制）。 |
| reusable output buffer | `B = 32,768` | `inflate.js:2103-2105` 用 `2 × chunkSize` 独立分配 `buf`。 |
| sliding window | `W = 32,768` | `inflate.js:2052-2057` 取默认 `MAX_BITS=15`，`:1815-1826` 传入 `1 << w`，`:1155` 独立分配 `win`。 |
| Huffman 主表 | `1,440 × 3 × 4 = 17,280` | `inflate.js:53` 定义 `MANY=1440`，`:1149` 分配 `Int32Array(MANY * 3)`。 |

可由 typed-array 源码直接核算的 payload 小计为 `33,999,760` 字节。`B` 大小下 fragment
数最多 `ceil(D / B) = 517`。`buffers` 本身在 `inflate.js:2112` 是 JavaScript Array，且
每个 typed array/ArrayBuffer wrapper、inflater 对象头的大小由 JS 引擎决定；工作区还含
`inflate.js:334-359`、`:1299-1302`、`:1465-1471` 的小型 JS/typed arrays，zip.js 没有给
出可移植的字节上界。本契约不隐瞒这项未知量，而是按每个 fragment `64 KiB` 计
`517 × 65,536 = 33,882,112`，再为其余容器/状态计 `1 MiB = 1,048,576`。保守核算合计：

```text
33,999,760 + 33,882,112 + 1,048,576 = 68,930,448 bytes
```

运行常量 `maxUncheckedInflateMaterializedBytes` 再上取整为 `80 MiB = 83,886,080 bytes`。
这是单次 fallback 的 operational ceiling；调用者持有的原 ZIP 字节另由
`maxCompressedBytes = 20 MiB` 约束，不混入该常量。对象元数据预留是针对当前目标运行时
的保守工程估计，并非跨任意 JS 引擎或延迟 GC 的 whole-process RSS 证明。sink 在接收下一
压缩块前检查本次输出、累计输出、压缩比和时间。

## 2. Office 格式纳入准则

单一权威表是 `packages/ui-mac/src/shared/ooxml.ts` 的 `OFFICE_OPEN_GATE_FORMATS`；renderer
与 main 只从它派生扩展名/MIME set，不得各持副本。

本准则只适用于 **OOXML（ZIP/OPC 容器）Office 格式**。域内不能可靠排除主动内容时必须
纳入并 fail-closed；这条不确定性规则不得用于任何非 ZIP/OPC 格式。扩展名与 MIME 是两个
独立的非可信声称：命中任一权威表项就必须过闸，不能因另一项缺失或为中性 MIME 放行。

当前权威表为 **20 个扩展名 / 20 个唯一 MIME**：

| 扩展名 | 对应 MIME |
| --- | --- |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.dotx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.template` |
| `.docm` | `application/vnd.ms-word.document.macroEnabled.12` |
| `.dotm` | `application/vnd.ms-word.template.macroEnabled.12` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.xltx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.template` |
| `.xlsm` | `application/vnd.ms-excel.sheet.macroEnabled.12` |
| `.xltm` | `application/vnd.ms-excel.template.macroEnabled.12` |
| `.xlam` | `application/vnd.ms-excel.addin.macroEnabled.12` |
| `.xlsb` | `application/vnd.ms-excel.sheet.binary.macroEnabled.12` |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `.potx` | `application/vnd.openxmlformats-officedocument.presentationml.template` |
| `.ppsx` | `application/vnd.openxmlformats-officedocument.presentationml.slideshow` |
| `.sldx` | `application/vnd.openxmlformats-officedocument.presentationml.slide` |
| `.thmx` | `application/vnd.ms-officetheme` |
| `.pptm` | `application/vnd.ms-powerpoint.presentation.macroEnabled.12` |
| `.potm` | `application/vnd.ms-powerpoint.template.macroEnabled.12` |
| `.ppsm` | `application/vnd.ms-powerpoint.slideshow.macroEnabled.12` |
| `.sldm` | `application/vnd.ms-powerpoint.slide.macroEnabled.12` |
| `.ppam` | `application/vnd.ms-powerpoint.addin.macroEnabled.12` |

`.xlsb` 的工作簿部件虽为二进制，文件外层仍是 ZIP/OPC package，因此保留纳入；除 `.xlsb`
外的旧式 Excel 二进制格式均在域外。通用 `.zip` 扩展名、`application/zip`、
`application/x-zip-compressed` 与 `multipart/x-zip` 不代表 OOXML 家族，不直接命中本闸。

MIME 拼写以 [IANA media-type registry](https://www.iana.org/assignments/media-types/media-types.xhtml)
及 OOXML/Office 注册为核对基线。每次升级 Office 目标版本或 zip.js 都必须重新核对 ZIP/OPC
属性与结构检测边界，不得越过 OOXML 容器域。

## 3. 外部打开闸与非特权 renderer 的边界

进入 `OFFICE_OPEN_GATE_FORMATS` 表示 claimed/extension fallback **本身不能取得系统外部打开
许可**，不表示该格式禁止一切本地呈现。renderer 仍按 detected MIME、claimed MIME、扩展名
的既有优先级选择 non-privileged renderer；未获精确结构证明时把 `externalOpen` 固定为
`blocked`。main 从同表独立派生 gate，并拒绝把未获精确 OOXML 证明的字节交给系统关联应用。

当前结构证明只识别无宏 `.docx/.xlsx/.pptx`，且要求结构 subtype、扩展名及所有非中性 MIME
一致。其它 17 个 OOXML 变体一律 fail-closed；三种基础格式在结构缺失、损坏、超限或声称
冲突时也 fail-closed。本变更不新增内容语义扫描或预览格式面，也不把 renderer 结果升级为
外部打开依据。

收窄后用户可见影响完整如下；“事实 fallback”只展示 artifact 事实与操作状态，不解析 Office
内容，因此这些行都没有应用内文档查看路径：

| 扩展名 | 失去 claimed/extension fallback 外部打开的条件 | 应用内查看路径 |
| --- | --- | --- |
| `.docx` | 结构不符、损坏、超限或声称冲突 | 无；事实 fallback |
| `.dotx` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.docm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.dotm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.xlsx` | 结构不符、损坏、超限或声称冲突 | 无；事实 fallback |
| `.xltx` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.xlsm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.xltm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.xlam` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.xlsb` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.pptx` | 结构不符、损坏、超限或声称冲突 | 无；事实 fallback |
| `.potx` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.ppsx` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.sldx` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.thmx` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.pptm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.potm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.ppsm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.sldm` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |
| `.ppam` | 始终（当前无该 subtype 的结构放行） | 无；事实 fallback |

## 4. 范围重裁

从本 PR 曾提出的最大 83 项表中完整移出以下 **63 个非 OOXML 扩展名**，恢复本 PR 之前的
系统外部打开策略：

- Word/文字处理（9）：`.doc/.dot/.wll/.odt/.rtf/.wps/.asd/.wbk/.fodt`。
- 文本/Web/XML（7）：`.txt/.htm/.html/.mht/.mhtml/.xhtml/.xml`。
- Excel/表格/连接/旧式家族（31）：`.xls/.xlt/.xla/.xlw/.xlm/.xll/.xlr/.ods/.csv/.prn/.tsv/.tab/.dif/.slk/.iqy/.oqy/.dqy/.rqy/.qry/.odc/.xlk/.xlc/.fods/.wk1/.wk2/.wk3/.wk4/.wks/.wq1/.wb1/.wb3`。
- PowerPoint/演示（7）：`.ppt/.pot/.pps/.ppa/.odp/.fodp/.ppz`。
- 此前已移出的 PDF/XPS、媒体与 iWork（9）：`.pdf/.xps/.oxps/.mp4/.mov/.wmv/.pages/.numbers/.key`。

这些行对应的 **33 个唯一 MIME** 也全部移出：
`application/msword`、`application/vnd.oasis.opendocument.text`、`application/rtf`、
`text/rtf`、`application/vnd.ms-works`、`application/vnd.oasis.opendocument.text-flat-xml`、
`text/plain`、`text/html`、`multipart/related`、`application/xhtml+xml`、`application/xml`、
`text/xml`、`application/vnd.ms-excel`、`application/vnd.oasis.opendocument.spreadsheet`、
`text/csv`、`text/tab-separated-values`、
`application/vnd.oasis.opendocument.spreadsheet-flat-xml`、`application/vnd.lotus-1-2-3`、
`application/x-quattropro`、`application/x-quattro-win`、`application/vnd.ms-powerpoint`、
`application/vnd.oasis.opendocument.presentation`、
`application/vnd.oasis.opendocument.presentation-flat-xml`、`application/pdf`、
`application/vnd.ms-xpsdocument`、`application/oxps`、`video/mp4`、`audio/mp4`、
`video/quicktime`、`video/x-ms-wmv`、`application/vnd.apple.pages`、
`application/vnd.apple.numbers`、`application/vnd.apple.keynote`。

该 63 项是本 PR 曾纳入表中的完整移出清单；其它非 OOXML 格式从未成为本闸权威项，也继续
保持原行为。HTML/XHTML、XML、TXT、CSV/TSV/TAB 与 PDF 仍走各自既有应用内 renderer；其余
移出项没有内置查看器时仍显示事实 fallback，但重新保留系统外部打开。普通 ZIP 及其中性
MIME 也不受本闸影响。

## 5. 验证合同

- 表结构测试只遍历权威常量，断言 20 个扩展名、20 个唯一 MIME、扩展名唯一且规范化；
  不得再复制一份 production “expected extension list”。
- renderer 与 main 测试对表中每一行生成 extension × MIME 三态：MIME 缺失、中性
  `application/octet-stream`、以及每个声称 MIME；还要生成 MIME-only case。
- 除 `.docx/.xlsx/.pptx` 精确结构证明外，权威表每行都必须保持 external-open blocked。
- renderer 与 main 必须逐项断言 63 个移出扩展名及其 MIME 不命中本闸；renderer 另须钉住
  HTML/XHTML、XML、TXT、CSV/TSV/TAB 与 PDF 的既有应用内路径。
- main 必须用真实普通 ZIP 字节钉住通用 ZIP 扩展名/MIME 不受 OOXML 家族闸影响。
- 完成门：从 `packages/ui-mac` 运行 `bun typecheck` 与 `bun test src`。
