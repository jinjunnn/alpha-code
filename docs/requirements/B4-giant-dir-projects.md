---
id: B4
title: 巨型目录当项目治理(/、~、~/Documents 建 Instance)
type: perf
priority: P1
status: in-sprint
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
