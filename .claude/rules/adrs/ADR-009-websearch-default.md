---
id: ADR-009
title: 桌面端默认对所有 provider 放开 websearch;alpha.env 作后续秘钥落点
status: accepted
date: 2026-06-18
related: [ADR-002, ADR-005, ADR-006]
---

## 背景
opencode `websearch`(Exa/Parallel)默认只给官方 `opencode`(Zen)provider(`registry.ts` 的 `webSearchEnabled()` 闸门)。第三方 provider(DeepSeek 等)只有 `webfetch`。该工具由 sidecar **直连** Exa/Parallel、不带 opencode 鉴权,key 为可选(仅避公共端点限流)。

## 决策(全部落 alpha 自有文件,零改 upstream)
1. **默认放开**:`ui-mac/src/main/server.ts` 的 `preferAppEnv()` 注入 `OPENCODE_ENABLE_EXA`(默认 `"1"`)→ 经 sidecar env 继承 → 对**任意 provider** 放开。**不改 `registry.ts` 闸门**。
2. **不做前端 key 入口**:终端用户默认拿 keyless + 限流的 websearch。
3. **秘钥基础设施**:`alpha-secrets.ts` 启动把 `alpha.env`(`KEY=VALUE`)灌进 `process.env`,**不覆盖已有**(shell 优先);`alpha.env` 已 gitignore。
4. **逃生开关**:`ALPHA_WEBSEARCH_DISABLE=1` / `OPENCODE_ENABLE_EXA=0` / `ALPHA_SECRETS_DISABLE=1`。

## 后果
- ✅ 第三方 provider 开箱即有 websearch,零配置;零改 upstream。
- ⚠️ 无 key 走公共端点会限流/降质;keyless 必返结果尚未运行时实测。
- 🔭 后续自有 websearch tool(见 [[ADR-010]] / [[ADR-011]] 云方向)上线时用 `ALPHA_WEBSEARCH_DISABLE=1` 避免撞车。
