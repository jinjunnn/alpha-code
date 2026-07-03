---
id: C8
title: ADR-002 sidecar 语义修订:承认 main-IPC 为桌面等价物
type: docs
priority: P2
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P2 / T6.4
---

## 背景/证据
ADR-002 的「自有独立 HTTP 进程(Hono)」从未建成;自有后端能力全走 Electron main IPC(桌面场景合理,但与 ADR 文字不符)。IPC-only 使未来非 renderer 客户端无法访问 account/cloud 能力——但当前无该需求(YAGNI)。

## 验收标准
1. ADR-002 追加修订:main-IPC 为桌面形态的 sidecar 等价物;真 HTTP sidecar 触发条件写明(出现非 renderer 客户端需求时再立);
2. GLOSSARY「sidecar」词条同步;
3. 相关文档引用复扫(ARCHITECTURE 硬约束③措辞核对)。

## 关联
ADR-002、GLOSSARY、C7(已关,引用规范)。
