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
