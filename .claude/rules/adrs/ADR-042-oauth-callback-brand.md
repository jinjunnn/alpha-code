---
id: ADR-042
title: OAuth 回环成功/失败页品牌为 alpha-code(L3 接管 core oauth page)
status: accepted
date: 2026-08-21
related: [ADR-007, ADR-029, ADR-033]
---

## 背景

MCP(及 Codex/xAI 等)OAuth 在 `127.0.0.1` 回环上结束时,浏览器看到的成功页来自
`packages/core/src/oauth/page.ts`。文案与字标仍是上游 **OpenCode**,与桌面/授权域的
**alpha-code** 产品身份矛盾(2026-08-20 云 MCP 授权完成后用户当场指出)。

[[ADR-007]] 的 build-time i18n transform **够不到**这条路径:页面由引擎 sidecar 的
loopback HTTP 直接 `res.end(html)`,不经 `ui-mac` Vite 打包。

按 [[ADR-029]] 阶梯:L0/L1 不可行(无接缝可叠、无构建变换入口);L2 patch 可为,但该文件
已是 alpha 产品壳的一部分且变更面小(纯展示),L3 单文件接管更直接,且与
[[ADR-033]] 既有「逐文件 UPSTREAM_EXCLUDES」同形。

## 决策

1. **L3 接管** `packages/core/src/oauth/page.ts`(及钉住品牌的
   `packages/core/test/oauth-page.test.ts`)。
2. 产品名统一为 **`alpha-code`**(与 `alpha.brand.product` / auth.tidelabs.click 一致);
   字标用文本 wordmark,不再绘制 OpenCode 几何标。
3. north-star `UPSTREAM_EXCLUDES` 登记上述两路径;放弃该文件的上游白嫖。

## 后果

- ✅ 所有走 `OauthCallbackPage` 的回环(含云 MCP)显示 alpha-code。
- ⚠️ 上游若重写该页,需手动 re-freeze / 再合并,不自动吃进。
