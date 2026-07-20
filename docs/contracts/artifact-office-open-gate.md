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

纳入一个扩展名须满足：当前桌面 Word、Excel 或 PowerPoint 在目标平台把它作为可打开的
文件形态或应用关联，并且它可承载宏、公式、链接/嵌入对象、外部数据连接或主动 Web 内容。
官方文档确认可打开但主动承载能力不能可靠排除的 rich/container 格式也保守纳入。扩展名
与 MIME 是两个独立的非可信声称：IANA 有专用注册时列出全部相关注册；无专用注册时使用
IANA 的 Office family MIME。命中任一项就必须过闸，不能因另一项缺失或为中性 MIME 放行。

当前权威表按族为：

- Word：`.docx/.dotx/.docm/.dotm/.doc/.dot/.wll/.odt/.rtf`；RTF 同时接受 IANA 的
  `application/rtf` 与 `text/rtf`。
- Excel：`.xlsx/.xltx/.xlsm/.xltm/.xlam/.xlsb/.xls/.xlt/.xla/.xlw/.xlm/.xll/.xlr/.ods`，
  Excel-associated 文本交换 `.csv/.dif/.slk`，外部连接 `.iqy/.oqy/.dqy/.rqy/.odc`。
- PowerPoint：`.pptx/.potx/.ppsx/.sldx/.thmx/.pptm/.potm/.ppsm/.sldm/.ppam/.ppt/.pot/.pps/.ppa/.odp`。

核对基线：[Microsoft current Office file-format reference](https://learn.microsoft.com/en-us/office/compatibility/office-file-format-reference)
与 [Excel supported-formats 表](https://support.microsoft.com/en-us/excel/file-formats-that-are-supported-in-excel)
决定“可打开”边界；[Excel 格式损失表](https://support.microsoft.com/en-us/excel/excel-formatting-and-features-that-are-not-transferred-to-other-file-formats)
核对 CSV/DIF/SYLK 的公式承载；Microsoft 的
[external-content/Query 安全说明](https://support.microsoft.com/en-us/office/security-privacy/block-or-unblock-external-content-in-office-documents)
和 [Excel data journey](https://support.microsoft.com/en-us/excel/how-data-journeys-through-excel)
决定 query/connection 风险；[IANA media-type registry](https://www.iana.org/assignments/media-types/media-types.xhtml)
决定 MIME 拼写。每次升级 Office 目标版本或 zip.js 都必须重做这两组核对，不得只在表尾
补单个后缀。

## 3. 决定不纳入

- `.txt/.prn/.dbf/.tsv/.tab`：通用导入或被动值，不是 Office-specific launch
  association；官方格式损失说明不保留可执行公式/宏语义。`.csv` 是例外，因为作为 Excel
  关联格式打开时单元格公式会被解释，所以已纳入。
- `.htm/.html/.mht/.mhtml/.xml`：Office 可以导入/导出，但目标 OS 默认交给浏览器或编辑器，
  不满足“Office 应用关联”这一半准则；它们继续走既有非特权 HTML/XML 处理。
- `.pdf/.xps`、图片与音视频 `.bmp/.gif/.jpg/.jpeg/.png/.tif/.tiff/.wmf/.emf/.mp4/.mov/.wmv`：
  固定版式或媒体交换，不执行 Office 宏/公式/连接，且通常关联非 Office viewer。
- `.wps/.dic`：legacy import/dictionary，官方资料没有证明它们是主动内容载体。
- `.xlc/.wk1/.wk2/.wk3/.wk4/.wks/.wq1/.wb1/.wb3`、`.ppz` 与 PowerPoint 95-or-earlier：
  current Microsoft reference 明列不支持，目标平台无当前 Office 关联；这也是 Lotus 与
  Quattro 族被复核后不纳入的理由。
- `.qry`：需先由 Microsoft Query 打开再另存 `.dqy`，不是 Excel 直接关联；`.dll` 是通用
  可执行库而非 Office 文档关联（`.xll` 已单独纳入）。
- `.asd/.wbk/.xlk`：Office 内部恢复/备份，不在 current supported open-format contract。
- `.fodt/.fods/.fodp` 与 `.pages/.numbers/.key`：current Microsoft reference 没有目标 Office
  关联依据。

## 4. 验证合同

- 表结构测试只遍历权威常量，断言扩展名唯一、规范化且每行 MIME 非空；不得再复制一份
  “expected extension list”。
- renderer 与 main 测试对表中每一行生成 extension × MIME 三态：MIME 缺失、中性
  `application/octet-stream`、以及每个声称 MIME；还要生成 MIME-only case。
- 除 `.docx/.xlsx/.pptx` 精确结构证明外，权威表每行都必须保持 external-open blocked。
- 完成门：从 `packages/ui-mac` 运行 `bun typecheck` 与 `bun test src`。
