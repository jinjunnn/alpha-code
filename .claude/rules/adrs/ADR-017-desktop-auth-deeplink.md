---
id: ADR-017
title: 桌面授权深链:scheme 必须进 Info.plist + PKCE 落盘抗冷启动
status: accepted
date: 2026-06-25
related: [ADR-012, ADR-002]
---

## 背景
桌面授权(browser-delegated OAuth/PKCE,见 `ui-mac/src/main/alpha-auth.ts`)用自定义 scheme `alpha-code://auth/callback` 把授权码从浏览器送回 app。2026-06-25 实测端到端,踩到两个**只在打包/冷启动态才暴露**的坑,导致"点回调无反应"和"app 不显示已登录":

1. **scheme 没进 Info.plist**:`index.ts` 运行时调了 `app.setAsDefaultProtocolClient("alpha-code")`,但 `electron-builder.config.ts` 的 `protocols.schemes` 只声明了 `["opencode"]`。打出来的 app 的 `Info.plist > CFBundleURLTypes` 只有 `opencode://` → macOS LaunchServices **不把 `alpha-code://` 路由给本 app** → 浏览器跳 `alpha-code://` 系统没人接,点了没反应。(`lsregister -dump` 实测:`alpha-code://` 无 handler。)
2. **PKCE 只在内存**:`startAuth()` 把 `pkce = {verifier,state}` 存在模块变量里。授权回调可能把 app **从未运行状态冷启动**(macOS `open-url` 冷启动)或在重装/重启后到达 → 新进程内存里 `pkce` 为空 → `completeAuth` 命中 `state mismatch — possible CSRF` → 静默放弃 → token 不兑换、不存凭证、UI 停在"登录"。(app main.log 实测:`deep link received via open-url … state mismatch`。)

## 决策(打包/授权标准流程)
1. **自定义 scheme 必须在 `electron-builder.config.ts` 的 `protocols.schemes` 声明**,且覆盖**所有渠道**(base + dev/beta/prod 的 override)。运行时 `setAsDefaultProtocolClient` 只是补充,对已打包 macOS app **不充分**——LaunchServices 只读 Info.plist。新增任何桌面深链 scheme,先改打包配置再说。
2. **PKCE(verifier+state)必须落盘**:`startAuth()` 写 `<userData>/alpha-pkce.json`(0600,短命、单次);`completeAuth()` 内存 `pkce` 为空时回退 `loadPkce()`;消费后 `clearPkce()` 删文件。保证回调跨"冷启动/重装/重启"存活。
3. **token 兑换地址走默认常量**:`shared/alpha-config.ts` 的 `ALPHA_ENDPOINTS.web` 为唯一真源(当前 `https://alphacodeone.com`),不依赖 shell env——否则 Finder 冷启动的 app 无 `ALPHA_WEB_URL` 会打到错域名。
4. **回调到达必须把 app 拉到前台**:macOS 经 `open-url`(非 `second-instance`)投递回调时**不会**自动激活 app,登录会在后台默默完成、用户停在浏览器。`open-url` handler 里补 `mainWindow.show()/focus()` + `app.focus({steal:true})`(steal 覆盖 macOS 防抢焦点),与 `second-instance` 行为对齐。

## 改 scheme / 重打包后的 verify 清单(必做)
- [ ] `electron-builder.config.ts` 各渠道 `protocols.schemes` 含目标 scheme
- [ ] `bun run ship:mac` 重打包重装
- [ ] `PlistBuddy -c "Print :CFBundleURLTypes" /Applications/alpha-code.app/Contents/Info.plist` 含该 scheme
- [ ] `lsregister -dump | grep` 该 scheme → 指向 `/Applications/alpha-code.app`
- [ ] app main.log:`deep link received` 后是 `login complete`,不是 `state mismatch`

## 后果
- ✅ 深链可靠回到 app 并完成 PKCE→token 兑换;跨重装/冷启动登录不丢。
- ✅ 把"运行时注册 ≠ 打包声明"这一隐性约束显式化,下次加 scheme/重打包不再漏。
- ⚠️ 重打包是 ad-hoc 签名(`identity=null`),app 签名变更会使旧 `alpha-auth.json`(safeStorage 钥匙串加密)**无法解密** → 重打包后需**重新登录一次**写入新凭证;属预期,非 bug。
- 🔗 web 侧契约见 alpha-web `DECISIONS.md` WA-7;web 的 `/auth/token` 依赖 `device_sessions.scope` 列(缺列会 500,部署不跑迁移须手动 ALTER)。
