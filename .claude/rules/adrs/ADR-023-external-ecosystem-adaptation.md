---
id: ADR-023
title: 外部生态适配 = 安装期转换器(不做运行时模拟)+ 插件包分发分层(npm 正源 / C 侧清单与精选资产)
status: accepted
date: 2026-07-05
related: [ADR-014, ADR-002, REQ-032, REQ-033, REQ-034, REQ-035]
---

## 背景

用户三连问(2026-07-05):① 插件包是否放 alpha-web 管理;② 是否写适配代码让 Claude Code / Codex 的插件在 alpha-code 上可用;③ 是否演进多 harness(③ 归 [[REQ-035]]/GOALS G5,不在本 ADR)。事实核查(源码 + 生态格式):

- **opencode 插件** = 面向 `@opencode-ai/plugin` hook 契约的 JS 模块,跑在引擎进程内、调宿主 API——**引擎绑定,异构引擎的代码插件互不可运行**(如 Chrome 扩展装不进 VS Code:不是文件格式问题,是它调用的接口在对方宿主中不存在)。
- **Claude Code "plugin"** = 大礼包目录(`plugin.json` 清单 + commands/agents/skills 的 markdown + `.mcp.json` MCP 配置 + hooks 脚本配置)——**大部分是声明式内容而非宿主 API 代码**,与 opencode 原语(command/agent/skill/mcp.servers)可逐类映射;唯 hooks(事件触发 shell 脚本协议)与 opencode hooks(JS API)语义只能部分对应。
- **Codex 无插件体系**(截至 2026-07 核查):可共享物 = MCP 配置(config.toml `mcp_servers`)、AGENTS.md、自定义 prompts——**天生通用,无需适配层**。

## 决策

1. **外部生态定制内容的兼容 = 安装期转换器(install-time conversion),钉死**:导入时解析外来格式 → **显式字段映射**(预览 + 用户确认,映射不到的字段提示而非静默丢弃/改写,C28 反 placebo 纪律)→ 产物为**原生 opencode 原语**(skill / command / agent / MCP 配置,多件套走 alpha 套件扇出,ADR-014)。装完与 alpha 自装内容无异:零运行时负担、零改上游、receipts 记 `origin: imported-*` 可溯源。
2. **明确不做运行时模拟层**(垫片让外来插件"以为自己跑在原生宿主里"):需要永久追踪异构引擎内部协议漂移(闭源/快速演进),且半兼容会制造「装上了但行为悄悄不对」的 placebo——比装不上更糟。异构引擎的**代码插件不承诺可用**;hooks 类部分可映射的能力,转换器**逐项声明**支持/不支持,不生效处 loud 提示。
3. **插件包分发分层**(与①配套):
   - **清单(metadata)**:alpha-web(C)catalog 下发,全类型条目统一([[REQ-032]],用户 2026-07-05 拍板落点 C);
   - **社区 opencode 插件包本体 = npm 正源**:版本、完整性、国内镜像(npmmirror)现成,**不自建托管**(重新托管 = 自建残缺 npm,纯负担);alpha-web 角色 = 精选 + 索引 + 指向「npm 包名@钉版」;
   - **自有/精选 vendored 插件**(如 opencode-notify)= 可上 alpha-web 资产存储,**前置逐包签名 + 安装时风险确认**(可执行代码,供应链红线)——即 REQ-032 phase 2,不抢跑。

## 后果

- ✅ 生态兼容收敛为**可枚举、可单测的转换规则**,不背运行时兼容债;转换产物随 alpha 既有生命周期(账本/桥/dispose/卸载)管理,无特例。
- ✅ 与 harness-as-executor([[REQ-035]])互补:任务委托给本机 Claude Code 执行时,其生态内容在它体内**原生可用**,无需任何转换——两条路合起来覆盖"用上外部生态"的绝大多数诉求。
- ✅ 分发面不重复造轮子:npm 管代码包、C 管清单与精选资产、引擎管发现加载,三层职责单一。
- ⚠️ 转换器需跟随外部格式演进(如 Claude Code plugin manifest 变更)——但只影响**导入动作**,存量已转换产物不受影响(它们已是原生原语)。
- ⚠️ hooks 语义映射覆盖率有限,转换器 phase 1 明确不转(诚实降级,详见 [[REQ-034]])。
- 🔭 执行载体:[[REQ-034]](导入转换器)、[[REQ-035]](executor)均 **parked**(用户 2026-07-05:暂不开发,想清楚再启动);激活时按本 ADR 执行。

## 修订(2026-07-06,REQ-046 —— catalog 作者真源收敛:C 仓唯一,A 内置改快照)

**背景**:REQ-032 交付了运行时分发链(远端验签 → 缓存 → 内置,远端可达时**整份替换**),但没收敛作者流程 —— A 内置 `alpha-catalog.json` 与 C `catalog-src/catalog.json` 是两份手工双写的作者源。两次实证漂移:S22 撤架只撤 A 侧(联网用户仍看 C 下发的三条恒失败条目,alpha-web PR #7 补齐);S23 上架 E2/E6 先只写 A 侧(用户当场点破)。

**拍板(用户,2026-07-06)**:**C 仓 `catalog-src/catalog.json` 是 agent / skill / command / MCP / plugin 条目的唯一作者真源**;上架/撤架的唯一作者动作 = 改 C → `build-catalog.mjs`(sha256 + ed25519)→ deploy,**A 零动作、联网用户即时生效**。A 仓只保留必须硬编码之物:
1. **验签公钥**(信任根,`remote-catalog.ts`,唯一常量源);
2. **离线回退快照底座** —— `alpha-catalog.json` **禁手编**,由 `ui-mac/scripts/sync-catalog-snapshot.mjs` 从已发布端点拉取+验签+**字节原样**快照(meta 落 `alpha-catalog.snapshot.json`);守卫 = `alpha-catalog.test.ts` sha256 断言(手编即红,红绿演练已过);发版 runbook 增「刷新快照」步(docs/runbooks/distribution.md);
3. **随包资产本体**(builtinAssetKey / vendoredAssetKey 所指文件 —— 出厂预置件与可执行物必须随包);
4. **catalog schema / 类型**(`catalog-types.ts`)。

**「新增条目零发版」对四类全部成立,plugin 只是通道例外而非发版例外**:

| 类型 | 条目(metadata) | 内容本体 | 新增是否需发版 A |
|---|---|---|---|
| MCP 连接器 | C 下发 | npm 正源(npx@钉版,运行时拉取) | 否 |
| skill | C 下发 | C 远程资产通道(sha256 逐文件钉死,不可变版本目录) | 否 |
| agent | C 下发 | 同 skill(单 .md 约定;**REQ-046 补接线** `installRemoteAgent` + `ext-install-remote-agent`,信任边界同远程技能) | 否(本修订起) |
| command | 不单列(ADR-014 O2:由 skill/MCP 生成) | — | 否 |
| plugin | C 下发 | **npm 发包**(可执行 JS 红线:不走 C 文本资产通道;C 托管属 phase 2 逐包签名,不抢跑) | 否(发 npm 包 + C 条目) |

仍需发版 A 的仅剩:出厂预置资产本体更新(vendored)、验签公钥更换(重大事件,见 catalog-publish.md)、catalog schema 演进(新 kind/字段;C 上架新形态前须确认存量 app 兼容 —— 向后兼容纪律)。

**后果**:✅ 上架/撤架单侧动作、机械守卫,不再依赖人肉双写;✅ 快照与已发布产物字节一致,diff/审计一一对应;⚠️ 内置底座含 remote-only 条目(断网时这类条目安装诚实失败,与联网用户断网行为一致);⚠️ schema 演进成为 A/C 之间唯一需要协调发布的耦合点(C 保持向后兼容或版本闸)。
