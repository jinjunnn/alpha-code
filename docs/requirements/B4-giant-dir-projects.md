---
id: B4
title: 巨型目录当项目治理(/、~、~/Documents 建 Instance)
type: perf
priority: P1
status: shipped
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §一 P1 / R2
---

## 背景/证据
`/`、`~`、`~/Documents` 各挂 Instance(fs watcher/git/skills 扫描);「归档」仅 UI 隐藏但照常取数(`alpha-sidebar.tsx:506` 渲染层 skip)。Instance 创建在上游(R2),alpha 杠杆 = 引导删除垃圾项目 + 隐藏项目不取数。`worktree==="/"` 跳过已做(PR #23)。

## 验收标准
1. 隐藏/归档项目零请求(session.list 等不再发起);
2. 垃圾项目(根/家目录级)有引导移除 UX 或默认不纳入;
3. 冷启动 bootstrap 日志无 `/`、`~` 级 Instance;
4. 与 B12 联动观测:常驻 watcher 数下降。

## 关联
B12(Instance 驱逐)、C5(skills 重扫,靠减 Instance 缓解)、A3(取数,已修)。

## 实施记录(2026-07-05,S17 T5 shipped)
- **数据层过滤**(`sidebar/worktree-filter.ts` 谓词 + 11 单测):`"/"` 全局桶 + macOS home 根(`/Users/<name>` exact)默认不纳入(验收②「默认不纳入」档);hidden(用户「归档」)项目从 `use-projects` 的 incoming 层剔除 → **渲染与 per-project `session.list` 双零请求**(验收①),引擎侧不再为其建 Instance(watcher/git/skills 扫描消失,验收④联动);归档操作即时生效(hide → reload)。
- **会话事件循环守卫**:被剔除项目的 firehose 会话事件不再触发 `loadProjects`(否则每事件白打一次 project.list)。
- **设计边界**:`~/Documents`/`~/Desktop` 级**不**自动剔除(存在真实使用场景)→ 引导 = 既有「归档」UX,归档后同样零请求;**已知限制:unhide 暂无 UI**(手清 localStorage `alpha.sidebar.hidden`),后续小 UX 债。
- **verified 待**:冷启动 bootstrap 日志复核(验收③,无 `/`、`~` 级 Instance)+ watcher 数实测(验收④)→ 真机批。
