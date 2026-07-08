---
id: REQ-059
title: 全面退役 `.opencode`(全局层)—— 真源 `~/.alpha/alpha.jsonc` + provider 域接管 + 存量 `~/.opencode` 清理
type: ux
priority: P1
status: archived
repo: A
created: 2026-07-07
source: 用户四连拍板(2026-07-07):品牌收敛最小改动 → 接管 XDG/项目 config → 项目单目录 → 全局一并消灭 `.opencode`、不用 symlink
related: [REQ-060, ADR-019, ADR-014, REQ-018, REQ-052, REQ-037, REQ-058, REQ-034, REQ-026]
design: ../designs/2026-07-07-project-alpha-only-extensions.md
---

# REQ-059 — 全面退役 `.opencode`(全局层)

## 需求(完整口径,用户拍板)

**alpha 在任何层级不再创建/写入任何 `.opencode`;alpha 的一切配置与内容真源在 `.alpha`。** 本档承载**全局(用户级)**半程,项目级 = [[REQ-060]];权威方案 = `designs/2026-07-07-project-alpha-only-extensions.md`(v3)。全局层具体含四件事:

1. **配置文件改名 + 搬家**:alpha 写入的引擎配置唯一真源 = `~/.alpha/alpha.jsonc`(mcp 连接器 / plugin / agent / command / skills 路径 / REQ-037 治理键 / **provider·BYOK 设置域**),`$schema` 保留。**不再有 `~/.opencode/opencode.jsonc`(symlink 方案已撤销)**。
2. **内容本体全在 `~/.alpha`**:skills(含出厂两跳的真源半跳)/ agents / commands / plugins(自包含 JS)照旧住 `~/.alpha/{skills,agents,commands,plugins}`;`~/.opencode` 侧的桥/链全部退役不再产生。
3. **provider/BYOK 写入域接管**:alpha 永不再写 `~/.config/opencode`(XDG);存量条目 copy-don't-delete 迁入真源(merge 序压制残留)。
4. **存量 `~/.opencode` 清理**:alpha 自有物拆除迁移后,目录残余仅引擎 junk 白名单(package.json 单依赖 `@opencode-ai/plugin` / node_modules / package-lock / bun.lock / .gitignore)则**整目录删除**;含用户自建内容则保留 + loud(alpha 零写入,诚实共存)。

## 引擎可见通道(改名/搬家为何可行 —— 源码钉死)

- **G1(主)**:sidecar 注入 `OPENCODE_CONFIG=~/.alpha/alpha.jsonc` —— 引擎原生「additional explicit config」**叠加合并**(上游文档 `customize-opencode.md:431`;v1 `config.ts:401-404`):per-instance 装配时读 → 作用域正确;**dispose 重建即重读文件** → 安装免重启保留;junk 循环(`config.ts:425-447`)只扫 directories 列表、不含该文件 → **`~/.alpha` 零引擎垃圾**;merge 位序在 XDG 之后(provider 压制成立)、项目之前(项目可覆盖)。
- **G2(备援)**:`@alpha-code/ext` 插件 `config` hook(`plugin/index.ts:240-249`,per-instance,与 REQ-060 同一套代码)补 G1 测不通的路由(v2 装载器只见 `OPENCODE_CONFIG_DIR`,`core/global.ts:64`)。
- **明确不用 `OPENCODE_CONFIG_DIR`**:v1 会对其做 ensureGitignore+npm install(垃圾进 `.alpha`)且钉死文件名 `opencode.json(c)`;v2 语义又是「替换全局目录」。
- **`OPENCODE_CONFIG` 这个 env 名不改、也无需改**:它是上游引擎的契约变量名(改名 = 改上游源码,违 ADR-005),由 sidecar fork 时内部注入,**用户永远不可见**;用户可见面只有文件本身,已叫 `alpha.jsonc`。
- **npm 之类(node_modules / package.json / package-lock / .gitignore)不迁 `.alpha`**:那是引擎对 config 目录的 plugin bootstrap 运行时产物,属引擎所有;`~/.opencode` 删除后,引擎这类产物只会出现在它自己的 `~/.config/opencode`(现状已如此)。「垃圾不进 `.alpha`」是 G1 选型的三大理由之一,**设计属性而非遗漏**。npm 钉版插件的包体安装位置(引擎侧)随 T0 spike 复核记录。
- 引擎**不会自发新建** `~/.opencode`(paths.ts home walk 只发现已存在目录)→ 清掉不会回来。
- 引擎从不写 home jsonc(写面 = XDG + `.gitignore`)→ 真源无碾链风险;XDG 文件**不做 symlink 桥**(引擎/CLI/编辑器原子写会碾链 → 静默裂脑,故 provider 接管走「写入面搬家」)。

## 配置文件全量盘点(「还有哪些一起改」终版)

| 文件 | 处置 |
|---|---|
| `~/.opencode/opencode.jsonc`(mcp/plugin/治理键) | 迁 `~/.alpha/alpha.jsonc`;不留任何指针;文件与目录按清理规则消失 |
| `~/.opencode/{skills,agents,...}` 桥/链 | 退役拆除;内容真源本就在 `~/.alpha`,发现走 G1/G2(skills 经 `skills: ["~/.alpha/skills"]` 稳定路径,新装 dispose 重扫即见) |
| `~/.opencode/{package.json,node_modules,package-lock,bun.lock,.gitignore}` | 引擎 junk 白名单 → 随目录删除;不迁 `.alpha` |
| `~/.config/opencode/opencode.json(c)`(provider 域) | alpha 停写 + copy-don't-delete 迁真源;XDG 目录本身是引擎的家(名字也不叫 `.opencode`),不在射程 |
| `~/.local/share/opencode`(会话库等) | 引擎数据目录,不动 |
| `alpha.env` / `~/.alpha/installs.json` / automations / 项目 `.alpha/*` | 已合规,不动 |
| 项目级(五类 + `<proj>/.alpha/alpha.jsonc` + 信任门 + 创建流) | → [[REQ-060]] |
| `.mcp.json` | 不做(Claude Code 私有约定,引擎零处读取;导入归 [[REQ-034]] parked) |

## 验收标准

1. **全新机器**:登录后装 MCP / skill / agent / plugin 各一 → 全部落 `~/.alpha`(alpha.jsonc 条目 + 内容目录),**全程不产生 `~/.opencode`**;dispose 后当前会话下一条消息可用(真机);
2. **存量机器(本机)**:启动 reconcile 后 `~/.opencode` **整目录消失**(jsonc 迁移 + skills 链拆 + junk 白名单删,本机预期路径),已装连接器(markitdown/filesystem/fetch)、治理三键、出厂技能零回归;重复启动幂等;含用户自建内容的机器 → 目录保留但 alpha 零写入 + loud;
3. **provider 接管**:设置里增删自定义供应商 → 写 `~/.alpha/alpha.jsonc`,XDG 零新写;存量拷贝迁移后模型选择器 / BYOK / key 状态零回归;
4. **作用域断言**:两个不同项目的会话同时可见全局连接器(G1 per-instance 合并生效);
5. **T0 通道判定表**交付:v1/v2 双装载器 × {mcp, skill, agent, command, plugin, provider} 每路由 G1/G2 判定;任何路由两通道皆不通 → **停,回用户拍板**(回退 symlink 不得自作主张);
6. 逃生开关(`ALPHA_JSONC_TRUTH_DISABLE=1` 回旧行为;`ALPHA_LEGACY_INSTALL_ROOT` 语义不变);data-clear 真源/receipts/密钥同清无孤儿;`alpha-check` 三关绿 + 北极星守卫绿(零改上游)。

## 任务拆解

- **T0(与 REQ-060 共享,GO 前唯一闸门)**:通道判定 spike —— fixture + 真机,产验收 5 的判定表;顺带复核 npm 插件包体安装位置。
- **T1 写入面切换**:sidecar 注入 `OPENCODE_CONFIG`(**A6 sidecar env 白名单补项**);`ext-config.ts` 全部写入(persistMcp/removeMcp/persistPlugin/removePlugin(Path)/治理叶子键/configHealth)与 **provider 域写入/读取**(persistProvider/alpha-models allowlist/provider-status/readConfiguredProviderKeys)切 `~/.alpha/alpha.jsonc`;既有单测跟改。
- **T2 reconcile(`engine-config-truth.ts`)**:存量迁移(所有权判定:顶层键白名单 ∧ mcp 名 ⊆ receipts ∧ 治理键 ⊆ 治理面)+ provider 拷贝迁移 + `~/.opencode` 清理(junk 白名单空则删)+ 幂等 + bail-out(loud);
- **T3 全局桥退役**:factory-skills 去 `.opencode` 半跳(REQ-052 通道改 G1 skills 路径);fs-installer 全局分支去桥;alpha-bridge 降级为 legacy-cleanup-only;
- **T4 口径**:data-clear{,-boot} 路径与文案;REQ-026 文档段;GLOSSARY 已同步;
- **T5 真机批**:验收 1/2/3/4(并入下一真机场次)。

## 非目标

- 不动引擎自己的 `~/.config/opencode` / `~/.local/share/opencode`(alpha 停写即达标);不把引擎 bootstrap 垃圾迁进 `.alpha`;
- 不改上游任何文件;不改 `OPENCODE_CONFIG` env 名(引擎契约、用户不可见);
- 不做 `.mcp.json`;项目级全部内容归 [[REQ-060]]。

## 风险与边界

- G2 hook 语义标注 "Notify"(变异可见性)与 v2 对 G1 的覆盖 = T0 靶子;回退 symlink 需用户重拍板(纪律写死在验收 5);
- **原生 opencode CLI 从此看不到 alpha 安装物**(用户指令覆盖,ADR-019 修订补充已记后果);
- 所有权判定宁 bail-out 不误迁;bail-out 态功能零损失,仅该机品牌收敛暂缓;
- 网络盘 home 等极端文件系统不在承诺内;
- `~/.opencode/opencode.jsonc.alpha-bak-102952`(会话残留)随清理一并消失。

## 修订记录

- v1(2026-07-07 晨):真源 `~/.alpha/alpha.jsonc` + `~/.opencode/opencode.jsonc` symlink 指针方案(经 BACKLOG/ADR 登记)。
- v2(同日晚,本稿):用户四连拍板收口 —— **撤销 symlink,全面零 `.opencode`**;通道改 G1(`OPENCODE_CONFIG`)+ G2(config hook);并入 provider 域接管与存量清理;项目级拆出 REQ-060。ADR-019(修订+补充)/ADR-014/GLOSSARY/BACKLOG 同步。
