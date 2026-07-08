# S30 真机批 — REQ-060 验收 1-6 + REQ-059 T3b + 信任门 UI(2026-07-08)

> ship:mac 装机(alpha @ feat/s30-req060-finish,commit 3dea94b6),CDP 9222 + AppleScript
> System Events(原生对话框点按)。fixture 四项目 `~/req060-t5-{a,b,c,d}`,验证后已删。

## 结论:全部 PASS(12 断言 + 2 条 loud 日志)

## 一、项目级通道 + alpha_register + 生 TS 拒收(项目 A,已 consent)

fixture:`.alpha/alpha.jsonc`(agent `t5-agent` / command `t5-cmd` / `skills.paths: ["./.alpha/skills"]`
相对路径)+ `.alpha/plugins/{raw-trap.ts, t5-ok.js}` + `.alpha/skills/t5-skill/`。

| 断言 | 结果 |
|---|---|
| /config 见 agent `t5-agent` + command `t5-cmd`(条目通道) | ✅ |
| `skills.paths` 相对条目按项目根解析为绝对(`/Users/tide/req060-t5-a/.alpha/skills`)—— 项目可移动 | ✅ |
| tool ids 含 `alpha_register`(T2 工具注册) | ✅ |
| **生 TS 拒收 loud**(验收4):`raw-trap.ts` NOT loaded + 日志指路「Bundle to self-contained ESM .js」 | ✅ |
| 同目录 `t5-ok.js` 正常 fan-out(`t5_plugin_tool` 在 tool ids)—— .ts 拒收不误伤 | ✅ |

```
[@alpha-code/ext] project plugin raw-trap.ts is raw TypeScript — NOT loaded (desktop runtime can't run raw TS, ADR-006). Bundle it to a self-contained ESM .js first.
[@alpha-code/ext] project plugin loaded (fan-out): /Users/tide/req060-t5-a/.alpha/plugins/t5-ok.js
```

```json
{"cfgStatus":200,"agentVisible":true,"commandVisible":true,"skillsPathResolvedAbs":true,
 "registerToolPresent":true,"tsTrapNotLoaded":true,"jsPluginLoaded":true}
```

## 二、信任门 UI 弹窗(验收2,项目 B=拒绝 / 项目 D=同意;原生 sheet 实点)

CDP 调 `window.api.ext.trustCheck(dir)` → 主窗弹原生 sheet(buttons=[允许加载, 仅文本扩展(不加载)],
checkbox=「我了解这会在本机运行该项目提供的代码」)→ AppleScript 实点。

| 断言 | 结果 |
|---|---|
| **拒绝路径**(B):点「仅文本扩展」→ prefs.json 落 `{granted:false, version:1}` | ✅ |
| 拒绝后重查:`{prompted:false, granted:false}` ×2(不重复弹) | ✅ |
| **同意路径**(D):勾知情 checkbox + 点「允许加载」→ `{prompted:true, granted:true}`;prefs 落 granted | ✅ |
| 同意后重查:`{prompted:false, granted:true}`(不重复弹) | ✅ |
| granted 项目 dispose 后 mcp 条目引擎可见(`t5grantmcp`) | ✅ |
| denied 项目 mcp 保持 gated(`t5gatedmcp` 不可见)+ 相邻隔离(B 看不到 D 的 mcp) | ✅ |

```json
{"grantedProjectMcpVisible":true,"deniedProjectMcpGated":true,"isolation":true}
```

## 三、REQ-059 T3b:全局 agent 零桥 + 条目化 + 净除

`window.api.ext.installBuiltinAgent("agents/code-reviewer.md", "code-reviewer")`(writeAgent 新管线):

| 断言 | 结果 |
|---|---|
| md 落 `~/.alpha/agents/code-reviewer.md`,files 仅此一项(**无桥文件**) | ✅ |
| **`~/.opencode` 不存在**(零 `.opencode` 不变量,装全局 agent 不再复活它) | ✅ |
| `~/.alpha/alpha.jsonc` 落 `agent.code-reviewer` 条目(agentMdToEntry:permission 嵌套/中文 prompt 正确转换) | ✅ |
| dispose 后引擎 /config 见到该 agent(prompt 完整,G1 通道) | ✅ |
| 卸载(`ext.uninstall`)净除:md 删 + alpha.jsonc 条目删 | ✅ |

## 四、零目录新增(验收3,项目 C)

空项目 C 经引擎建实例 + /config 查询后,目录仍为空(无 `.alpha`、无 `.opencode`)。✅

## 覆盖对照(REQ-060 验收标准)

| 验收 | 覆盖 |
|---|---|
| 1 创建产物全在 `.alpha`、免重启可用 | 通道全链已证(条目→/config→dispose);**模型经会话实调 alpha_register 未演**(需真 LLM 会话,机制 = 工具注册✅+纯逻辑 33 测) |
| 2 信任门同意/拒绝双路径 | ✅ 全真机(原生 sheet 实点) |
| 3 零目录新增 | ✅ |
| 4 生 TS 拒收 loud | ✅ |
| 5 存量共存 | 用户自建 `.opencode` 零触碰 = reconcile 既有纪律(REQ-059 批已证);agents 桥迁移逻辑单测覆盖,本机无存量桥验证物 |
| 6 REQ-036 创建→发现→免重启复测 | 通道级已证(同 1);会话级实测归下一次日常使用 |
| 7 零改上游 + alpha-check 绿 | ✅(north-star guard + 549 测) |

## 残留物

fixture 四项目已删;`~/.alpha/alpha.jsonc` 的 code-reviewer 条目已卸载净除;app 已退出。
