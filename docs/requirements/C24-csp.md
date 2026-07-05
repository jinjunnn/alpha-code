---
id: C24
title: CSP 落地 + 撤 alpha 自注入 ACAO:*(封 exfil 通道)
type: security
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §7b / 核查 §4
---

## 背景/证据
无 CSP(`renderer/index.html` 无 meta;`onHeadersReceived` 只注 ACAO/ACAH)**叠加 alpha 强制 `ACAO:*`(`windows.ts:161-171`)** → 即便 `nodeIntegration:false` 挡 RCE,token/会话数据 exfil 通道仍开。是 C12 的渲染侧对偶。⚠️ 册 §7g 告诫:CSP 可能断 renderer,需充分验证。

## 验收标准
1. 撤 `ACAO:*` 注入(先行,含 C12 的 alpha 侧动作);
2. renderer CSP 落地(connect-src 收敛到 sidecar/必要域;禁 inline-script 视兼容评估);
3. 全功能回归:终端/diff/流式/hub/登录/更新器逐屏走查(隔离 dev + 打包双态);
4. exfil 验证:注入测试脚本向外域 fetch 被 CSP 拦截(取证)。

## 关联
C12(对偶)、C27(纵深防御同批)、C25。
