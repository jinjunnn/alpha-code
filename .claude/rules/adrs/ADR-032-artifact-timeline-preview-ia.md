---
id: ADR-032
title: 本地产物 timeline 链接行与右栏统一预览;云端产物链接外开
status: accepted
date: 2026-07-21
kind: adr
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-21
related: ["alpha-work:REQ-092", "alpha-work:REQ-097"]
---

# 本地产物呈现与预览 IA

> **勘误 2026-08-28(不改原文,决策不变)。** 本 ADR 的**决策**仍然成立;下述三处
> 引用的是一条**在当时即为假**的事实前提,阅读时请以本勘误为准。
>
> **假前提**:「执行地基已交付……PDF 独立 worker」(背景段)、
> 「| PDF | 现役 PDF 独立 worker 查看器 |」(决策表)、
> 「图片/HTML/MD/PDF 为现役 renderer」(接线段)。
>
> **地面真相**:PDF 独立 worker **从未交付**。它的实现票 `#296` 自建立起始终
> Triaged、**零代码 PR**,已于 2026-08-28 关闭;`PdfCard` 的注释自书
> 「未 ship PDF.js 隔离 worker 前不伪造内置查看器」,即产品里一直只有诚实卡片。
>
> **同时,那个 worker 本来就不需要**:实测 `electron@42.3.3`(产物实际使用的那份)
> **自带完整 Chromium PDF viewer**,`webPreferences.plugins: true` 即可 ——
> 三臂对照(不存在的文件 → `ERR_FILE_NOT_FOUND`;`about:blank` → 0 frames/8.2 KB;
> 真 PDF → **1 个子 frame**/19.6 KB)+ 截图肉眼确认工具栏、缩略图栏与正文渲染。
> 证据:`/tmp/claude-501/spike-pdf-result.md`(2026-08-28)。
>
> **本勘误改变什么**:PDF 预览的**能力**归平台,不需要自建 worker;但**呈现形态**
> (以什么载体嵌进右栏、`plugins: true` 的开启范围、viewer 自带的下载/打印按钮是否
> 可接受)仍是未决的设计题,归 `#244`(REQ-108)的方案基线。
>
> **本勘误不改变什么**:统一 IA(本地产物在 timeline 以链接行呈现、点开进右栏唯一
> 预览面)、Office 走提取视图而非保真渲染 —— 两者均维持原裁决。
>
> 教训归档:**「issue 有票」不等于「东西做了」**。判某个依赖已落地,证据是代码里
> 找得到消费者(两条独立检索轴交叉),不是 issue 的状态色块。同类假表述在 `#438`
> 正文亦有一处,已于该票评论更正。

## 背景

timeline 目前不显示任何产物;产物首现于侧栏唤起的 Artifact Workbench。
REQ-097 重框(2026-07-21,本地路径)暴露一个从未统一裁决的面:产物在哪里
首现、点开后在哪里预览、每类文件用什么载体——Office 讨论中先后出现系统
浮层、缩略图卡等形态,逐需求各自发明。owner 于 2026-07-21 裁决统一 IA。

执行地基已交付:隔离预览基座与 renderer registry(REQ-095/096——隔离
HTML 预览、PDF 独立 worker、图片预算、大文本虚拟化),以及 OOXML 结构闸
(`packages/ui-mac/src/shared/ooxml.ts`,#281)。

## 决策

1. **本地产物在 timeline 以链接行呈现**:文档名 + 链接标记,出现在产生它
   的会话回合处。轻量行,不做大卡片、不做缩略图卡。
2. **点击链接行 → 右栏打开预览**:右栏预览面锚定现有 Workbench 预览列
   (聚焦该产物;呈现细节归设计稿)。Workbench 保持管理/详情面身份。
3. **可预览类型与载体**(白名单枚举,域外不称"预览"):

   | 类型 | 右栏载体 |
   |---|---|
   | 图片 | 现役受控图片渲染 |
   | HTML | 现役隔离 HTML 预览 |
   | Markdown | 渲染视图 |
   | PDF | 现役 PDF 独立 worker 查看器 |
   | Office 三件套(无宏,结构闸 PASS) | 结构化提取预览(REQ-123,alpha-code#438)为面内内容载体;「快速查看」(macOS Quick Look 系统浮层,`BrowserWindow.previewFile`)为全保真通道;受控外开保底 |

   白名单外类型:链接行照常,右栏呈现元数据与有界源文,不称"预览"。
4. **云端产物不进本面**:桌面端不重建云端产物浏览面,以认证链接外开
   (浏览器/portal);延续 REQ-092「产物内容不进 status/MCP/IPC」契约。

## 被否决的替代

- **timeline 缩略图卡/大卡片**:信息密度差、时间线变重,owner 否决。
- **自建 Office 可视化渲染**(docx-preview/SheetJS 或本地 LibreOffice 转换):
  保真度、依赖与解析攻击面不可接受,REQ-097 重框时已否决;面内内容由结构化
  提取(REQ-123)承担,如实声明保真差异,不伪装所见即所得。
- **Quick Look 作为唯一 Office 载体**(面内无内容):owner 否决——右栏必须
  能直接看到内容,系统浮层只作全保真通道。

## 后果与实施归属

- timeline 链接行 + 右栏联动 + 类型注册表接线 = 新需求(REQ-124,注册于
  alpha-code);图片/HTML/MD/PDF 为现役 renderer,REQ-124 只做联动接线,
  不重建任何 renderer。
- Office 面内内容 = REQ-123(alpha-code#438);结构检查状态呈现 + 快速查看
  通道 = REQ-097(alpha-code#189)。三者互补,边界不重叠。
- 云端产物链接的具体形态随云端半场真实化再细化(挂起,见 alpha-work#3)。
