---
title: "cap:workbench L2 真机矩阵 — #323 双 run 十 descriptor + 三模式 + 产物发现"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2026-10-19
---

# cap:workbench L2 真机证据 — #323(2026-07-19)

归并 REQ-088/094 的 Workbench harness 与产物发现验证(capability = workbench)。真机 Electron dev
(CDP 9222 裸 WebSocket,`OPENCODE_TEST_ONBOARDING=1` 全隔离根),基点 HEAD = `a5613686`,只读驱动。

种子(契约合法):`<PROJ>/.alpha/runs/` 下真实双 run。descriptor 逐条经契约镜像
`validateArtifactDescriptor` 自检、manifest 经 `validateArtifactManifest` 自检后落盘 —— 非绕过。
- **job_caprun1**:manifest 十 descriptor,覆盖 verified×4 / unverified×2 / mismatch×2(内容篡改)/ missing×2
  (盘上不落),加 1 个 manifest 外盘上文件(legacy 卡);后又追加带脚本 SVG 与 HTML 冒充 png(#324 复用)。
- **job_caprun2**:无 `artifacts.json` 的 legacy run(只读发现)。

## 矩阵结果

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 侧栏「产物」入口打开 Workbench(生产 `toggleWorkbench`) | PASS | `.alpha-wb-page` + `[data-alpha-workbench]` 在场(`323-workbench.json` open/initial) |
| 2 | 双 run 发现 + 每 run 产物计数/字节/manifest 标记 | PASS | run 列表含 `job_caprun1(10 个产物·272B·manifest 只读)` 与 `job_caprun2(legacy)`(`323-workbench.json` runA.runs) |
| 3 | 十 descriptor 卡片全状态逐一映射 | PASS | 卡片状态序列 = verified×4 / unverified×2 / mismatch×2 / missing×2 + legacy×1(manifest 外文件)(`323-workbench.json` runA.cards);截图 `323-w2-runA-cards.png` |
| 4 | 预览/源码/元数据三 tab(role=tab,ARIA selected) | PASS | `report.md` 选中 → 三 tab `a-wb-tab-{preview,source,metadata}`,markdown 预览渲出 `<h1>`(`323-workbench.json` mdPreview, panelHasHeading=true, decisionChip=markdown);截图 `323-w3-md-preview.png` |
| 5 | 元数据 tab 展示 renderer decision + provenance + digest + 路径 | PASS | metadata 面含 `renderer markdown`、`sha256 3287956a…`、`provenance pipeline·job_caprun1`、`路径 artifacts/report.md`(`323-workbench.json` metadata);截图 `323-w4-metadata.png` |
| 6 | mismatch 卡诚实降级(不伪装 verified)+ 完整性横幅 | PASS | `tampered.bin` 选中 → `data-state=mismatch` + error 横幅「完整性校验不符(digest/尺寸不一致)—— 内容按原样显示」(`323-workbench.json` mismatch);截图 `323-w5-mismatch.png` |
| 7 | missing 卡不可预览 + 可重下 | PASS | `gone.pdf` → `data-state=missing`、面板「文件已在盘上消失」+ 重下按钮在场(`323-workbench.json` missing hasDownloadBtn=true) |
| 8 | legacy run 只读发现(无 manifest → 诚实 warning,不合成假 descriptor) | PASS | job_caprun2 → 单 legacy 卡 `old-report.md`,warning「legacy run: artifacts/ discovered read-only without artifacts.json」(`323-workbench.json` runB);截图 `323-w6-runB-legacy.png` |
| 9 | 选中(run+artifact)跨 reload 持久化恢复 | PASS | 选 job_caprun1 + `data.csv` → reload → 重开 Workbench:`data.csv` 卡回到 active(`323-workbench.json` restored);截图 `323-w7-restored.png` |
| 10 | 离线诚实态(平台列表不可用 → 只显本地) | PASS | notice「平台产物列表不可用(离线或未登录)—— 仅显示本地产物」如实呈现(`323-workbench.json` runB.notices) |
| 11 | SessionWorkspace keep-alive across Files/Changes/Inspector 模式 | **FAIL** | Workbench 是产品根级独立全屏 Portal(`wbInsideWorkspace=false`,parent=DIV),不承载于 SessionWorkspace;仅 preview/source/metadata 三 tab,无 Files/Changes/Inspector 模式(`323-workbench.json` container)。已由**开放** CODE 票 #285 承载(REQ-094) |
| 12 | 跨来源产物发现(cloud/automation/tool → timeline artifact card) | **FAIL** | 自动化 `report.md` 写在 run 根,发现器只扫 `artifacts/`(`automation-scheduler.ts:291` vs `artifact-service.ts:166`);timeline 无 artifact 通路。已由**开放** CODE 票 #287(REQ-094)承载 |

10 PASS / 2 FAIL。

## FAIL 处置(不修码)

两项 FAIL 均为容器所有权/发现链缺口,已在 2026-07-14 S40–S49 审计(REQ-094)disposition 中开出对应
**开放** CODE 票,不重复新开:
- #285 `[REQ-094][CODE] Host Artifacts, Files, Changes, and Inspector in the release SessionWorkspace`(含 keep-alive)
- #287 `[REQ-094][CODE] Route cloud, automation, and tool outputs to timeline artifact cards`

## 判定

Workbench 作为独立全屏产物查看器的核心矩阵(双 run 发现、十 descriptor 全状态、三 tab、mismatch/missing
诚实、legacy 只读、跨 reload 恢复)全 PASS;SessionWorkspace 承载 + Files/Changes/Inspector keep-alive +
跨来源发现两项 FAIL,已挂开放父需求 CODE 票。矩阵执行完毕,本票关闭(completed)。
