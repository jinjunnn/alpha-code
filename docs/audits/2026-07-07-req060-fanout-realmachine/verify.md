# REQ-060 plugin host fan-out 真机验证(+ 信任门 consent 翻转 + home 边界修复)

> 2026-07-07,ship:mac 本地包(alpha @ PR #146 合入后),CDP 9222 实测。
> 方法与 T0 spike 同构([2026-07-07-req060-confighook-spike](../2026-07-07-req060-confighook-spike/verify.md)):
> 装机包启动 → renderer `window.api.awaitInitialization()` 取引擎凭证 → 直查引擎 HTTP。

## 结论:fan-out 真机 PASS(6/6)+ 发现并修复 1 个 home 目录边界 bug

## fixture

两个干净项目(避开仓库 `.opencode`):

- **trusted** `~/req060-fanout-t/.alpha/`:`plugins/proj-fanout.js`(自包含 ESM,ADR-006:仅 node 内建)
  + `prefs.json`(`extensionsConsent.granted: true`,手写 —— UI 弹窗是后续任务)
- **untrusted** `~/req060-fanout-u/.alpha/`:同一插件,**无** prefs.json

fixture 插件暴露:tool `proj_fanout_hello`(args:{},走引擎 legacyJsonSchema 兜底,零 zod 依赖)+
`event` hook(把事件追加写 `.alpha/fanout-events.log`,证非 tool hook 转发)。

## 证据(引擎 `/experimental/tool/ids?directory=` 实测)

| # | 断言 | 结果 |
|---|---|---|
| 1 | trusted 项目 tool ids 含 `proj_fanout_hello` | ✅ true(fan-out 注册生效) |
| 2 | untrusted 项目 tool ids **不含** `proj_fanout_hello` | ✅ false(信任门:可执行物未 consent 不加载) |
| 3 | 两侧 `alpha_reload/alpha_echo/alpha_ping` 完好 | ✅(mergeHooks own 优先,自有工具零回归) |
| 4 | event hook 转发:trusted 建会话 → `.alpha/fanout-events.log` 落 `session.created` | ✅(untrusted 侧无文件) |
| 5 | loud 日志:`project plugin loaded (fan-out): ~/req060-fanout-t/.alpha/plugins/proj-fanout.js` | ✅ |
| 6 | **consent 翻转免重启**:untrusted 写 prefs.json → `POST /instance/dispose` → 重查 tool ids 含项目 tool | ✅(dispose=200,tool 即刻出现 —— 将来 UI 弹窗驱动的正是这条链) |

原始断言输出(CDP Runtime.evaluate):

```json
{"trusted":{"status":200,"hasProj":true,"sample":["alpha_reload","alpha_echo","alpha_ping","proj_fanout_hello"]},
 "untrusted":{"status":200,"hasProj":false,"sample":["alpha_reload","alpha_echo","alpha_ping"]}}
{"dispose":200,"toolids":200,"hasProjAfterConsent":true}
```

## 真机发现:home 目录实例把全局 `~/.alpha/alpha.jsonc` 当项目配置(已修)

首次启动日志即暴露:

```
[@alpha-code/ext] project has UNTRUSTED executable extensions (mcp) — not loaded until consent: /Users/tide
```

**根因**:config hook / fan-out 按 `<directory>/.alpha` 取项目配置;home 目录实例(directory=`~`)的
`<dir>/.alpha` 恰是**全局** `~/.alpha` —— 全局 alpha.jsonc(已经 G1/OPENCODE_CONFIG 注入)被二次当项目
配置读,全局 mcp 被信任门误 gated。

**影响面**:功能零损失(`mergeProjectConfig` add-only,G1 已注入的条目不受影响),但 ① loud 噪声
+ 将来信任门 UI 会对 home 弹「信任你自己的全局配置」的荒谬 consent;② home 侧一旦误授 consent,
`~/.alpha/plugins/`(vendored 全局插件,已走 `config.plugin[]`)会被 fan-out **双重加载**(hook 双发)。

**修复**:`isGlobalAlphaDir(directory, globalAlphaRoot)`(纯逻辑 +4 单测)—— `<dir>/.alpha` 解析后
等于全局 root(`ALPHA_GLOBAL_DIR` || `~/.alpha`)→ config hook 与 fan-out 整体跳过。

### 修复后复验(rebuild ship:mac,2026-07-08)

| 断言 | 结果 |
|---|---|
| 主动触发 home 实例(`/config?directory=~` = 200,**非空断言**)后,stdout 全程无 `UNTRUSTED … /Users/tide` | ✅ |
| home 实例全局 mcp 完好(8 条:fetch/markitdown/feishu-lark/yuque/github…)—— guard 跳过 hook,G1 通道功能零损失 | ✅ |
| 断言 1/2/3 重跑:trusted `proj_fanout_hello` true / untrusted false / 两侧 `alpha_ping` 完好 | ✅ 零回归 |
| trusted 项目 fan-out loud 行仍在(guard 只挡 home,不伤项目通道) | ✅ |

```json
{"homeConfig":200,"homeGlobalMcpCount":8,"homeMcpSample":["fetch","markitdown","feishu-lark","yuque","github"],
 "trustedHasProj":true,"untrustedHasProj":false,"alphaToolsIntact":true}
```

## 残留物

fixture `~/req060-fanout-{t,u}` 验证后删除。

## 剩余(REQ-060 后续批)

- 信任门 UI 弹窗(renderer 检测 gated → consent 写 `.alpha/prefs.json` → dispose,链路本次已真机证通)
- T2 `alpha_register` ext 工具;T3 创建流改造(agent-creator 落 `.alpha` + REQ-036 修订);T5 真机批
