---
id: ADR-007
title: 前端品牌化走 build-time transform,不原地改 upstream 字符串
status: accepted
date: 2026-06-15
related: [ADR-005, ADR-006]
---

## 背景
"OpenCode"→"alpha-code" 的文案几乎全在 upstream(i18n + ~245 组件);app `LanguageProvider` 无运行时 override。原地改 = merge 冲突;bun `patches/` 改不了 workspace 源码包。且很多 "OpenCode" 是真实事物名(Zen 网关 / `opencode.json` / CLI / 团队)不能盲替。

## 决策(全部只增不改磁盘 upstream)
1. **自有 chrome(`ui-mac`):直接改**(app 名、窗口标题、`<title>`、图标/splash、自有 i18n)。
2. **upstream 共享文案:build-time transform** —— `ui-mac/scripts/brand-i18n.ts`(Vite `enforce:"pre"` 插件)打包时按精选清单重写 i18n 的**自我指代**;磁盘源码一字节不动 → merge 永不冲突;漏改 `warn`。
3. **agent 身份:全局 instruction 注入** —— `alpha-identity.md` 经 `OPENCODE_CONFIG_CONTENT.instructions` **叠加**注入(`ALPHA_IDENTITY_DISABLE` 可关);同点是将来挂 `@alpha-code/ext` 的接缝。

## 后果
- ✅ 深度品牌化 + 零冲突;git-tracked upstream == `dev`。
- ⚠️ 覆盖面 = 精选清单(en+zh 自我指代);其它语言/组件硬编码仍显示 OpenCode,按需扩展;transform 基于精确子串,漏改静默(有 `warn` 兜底)。
