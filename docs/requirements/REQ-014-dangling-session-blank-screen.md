---
id: REQ-014
title: 悬空会话路由致「Not found」白屏 — 路由恢复前校验会话存在
type: bug
priority: P2
status: registered
repo: A
created: 2026-07-03
sprint: —
source: REQ-002 联调 BP-3(audits/2026-07-03-req002-proxy-e2e.md)
---

## 背景(为什么)
`opencode.global` store 的 `tabs.recent`(`{key:"sidecar\n/server/<b64>/session/<id>"}`)与 `tabs[]` 持久化上次打开的会话路由。当被指向的会话 id 已不存在(用户删会话、DB 换库、会话 GC)时,冷启动 alpha 恢复该路由 → 整个 app 卡在左上角纯文字「Not found」白屏:**无侧栏、无首页、无任何恢复入口**,只能手工摘除 store 里的悬空指针才能救回。REQ-002 联调删测试会话后稳定复现。

## 目标(做什么)
路由恢复(读 `tabs.recent`/`tabs`)时,对每个待恢复的会话路由校验其会话是否仍存在(经 SDK `session.list`/`session.get` 或既有 projects store);不存在则跳过该条并回退首页(AlphaHome),而非把整个 renderer 渲成上游 `Not found`。

## 验收标准(可验证,逐条)
1. 构造悬空 `tabs.recent`(指向不存在会话 id)→ 冷启动 app **正常起到首页/有效会话**,不再白屏 Not found;
2. 悬空条目被静默剔除或降级(不复活死路由),有效 tab 不受影响;
3. 无悬空时行为不回归(截图核验既有会话恢复正常);
4. 关联 B11:若选择呈现「上次会话已不存在」提示,走统一错误面而非死屏。

## 非目标
- 不改上游 `Not found` 组件本身(上游只读);兜底在 alpha 路由恢复层。
- 不做会话软删除/回收站(另议)。

## 方案 / 关联
- 落点:alpha renderer 路由恢复逻辑(`ui-mac/src/renderer/*`,消费 `window.api.storeGet("opencode.global", "tabs.recent"/"tabs")`);
- 关联 [B11](B11-unified-error-surface.md)(呈现面)、REQ-002 audit BP-3。

## 验证记录
_verify 时补。_
