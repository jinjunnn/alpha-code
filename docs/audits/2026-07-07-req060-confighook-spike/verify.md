# REQ-060 T0 GO gate — config hook 变异可见性真机 spike

> 2026-07-07,ship:mac 本地包(含 @alpha-code/ext config hook)。分支 feat/req059-060-config-truth。
> Gate 纪律(REQ-060 §风险):config hook 变异 cfg 若不被引擎消费方看到 → 回退单指针方案 + 回用户拍板。

## 结论:GATE PASS —— 项目级 `.alpha`-only 通道成立,REQ-060 可 GO

config hook(per-instance 读 `<dir>/.alpha/alpha.jsonc` → mergeProjectConfig 变异 cfg)的变异**被引擎
`/config` 消费方完整看到**;相邻项目隔离成立。design §二.2 标注的 "Notify" 语义存疑就此消解。

## 方法

fixture 项目 `~/b21-test/.alpha/alpha.jsonc` 注入项目级 agent/command/mcp:
- agent `proj-spike-agent`、command `proj-spike-cmd`、mcp `projspikemcp`(enabled:false 防真连)

装机包启动,CDP 查引擎 `/config?directory=<dir>` 两个项目对比。

## 证据(引擎 /config 实测)

| 断言 | 结果 |
|---|---|
| `~/b21-test` status | 200(config hook 注入不破坏配置) |
| `~/b21-test` 含 proj-spike-agent | ✅ true(agent 变异可见) |
| `~/b21-test` 含 proj-spike-cmd | ✅ true(command 变异可见) |
| `~/b21-test` 含 projspikemcp | ✅ true(mcp 变异可见) |
| 相邻项目 `~/app/alpha-code` 含 proj-spike-agent | ✅ false(隔离) |
| 相邻项目含 projspikemcp | ✅ false(隔离) |

## 判定表(REQ-059/060 共享 T0 收官)

| 通道 | 路由 | 判定 |
|---|---|---|
| G1 `OPENCODE_CONFIG` 全局文件 | mcp/plugin/agent/command/skills/provider | ✅ GREEN(REQ-059 真机 verified) |
| config hook 项目级 | mcp | ✅ 变异可见(本 spike) |
| config hook 项目级 | agent | ✅ 变异可见(本 spike) |
| config hook 项目级 | command | ✅ 变异可见(本 spike) |
| config hook 项目级 | skills.paths | 🔶 未单独验(同 config 通道,agent/command/mcp 三路已证;object schema 已锁) |
| config hook 相邻项目隔离 | 全部 | ✅ per-instance(本 spike) |
| plugin host fan-out | plugin | 🔶 T1 未做(ADR-006 生 TS 雷,host 动态 import) |

## 剩余(GO 后 T1-T5)

- T1 `alpha-project-bridge` 完整:skills.paths 项目级 + plugin host fan-out + **信任门**(项目自带 mcp/plugin
  = 加载可执行物,首次 per-project consent,ADR-021 模式)
- T2 `alpha_register` ext 工具(模型不手改 config)
- T3 创建流改造(agent-creator 落 `<proj>/.alpha/agents` + REQ-036 修订)+ fs-installer 项目分支
- T5 真机批(创建→发现→免重启 dispose;信任门拒绝路径)

## 附:引擎行为确认

- config hook 变异对 `/config`(per-instance 装配)可见 = 与 REQ-059 的「G1 标准 merge」殊途同归(都在
  loadConfig 装配期并入,消费方读已合并态)。dispose 重建重触发 hook = 免重启(REQ-036 dispose 链已有)。

## 残留物

fixture `~/b21-test/.alpha` 已删(spike 后清理)。
