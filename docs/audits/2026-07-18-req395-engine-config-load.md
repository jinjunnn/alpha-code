---
title: 引擎 config 加载语义勘破（REQ-104 #395 主权注入的地面真相）
kind: audit
status: active
owners:
  - alpha-code
last_reviewed: 2026-07-18
---

# REQ-104 #395 — 引擎 config 加载语义勘破（主权注入的地面真相）

> 分支 `feat/395-default-disabled`
> 触发:Codex #399 r9→r11 —— legacy 残留探测器逐文件短路,与引擎真实合并语义(文件集/顺序/mergeDeep-vs-union/自动发现目录/TOML/env-content)持续偏差(r10→r11 finding 4B→8B 发散)。
> 方法:只读源码勘破(config.ts / core/global.ts / config/{agent,plugin,paths}.ts / sidecar.ts)。
> 结论(r11 定案):**逐源探测是发散无底洞,弃用**。改为**主权注入**——alpha 把 disabled mcp/agent 覆盖注入 `OPENCODE_CONFIG_CONTENT`(引擎加载序 **step 6**,压过一切 in-scope 源),让 alpha 权威。本报告的引擎加载序/合并语义事实即该设计成立的地面真相(尤其 OPENCODE_CONFIG_CONTENT 在所有 in-scope 源之后加载)。以下"探测器"章节保留为历史设计参考。

## 结论(探测器地面真相)

一个「账本 disabled、alpha.jsonc 已投影禁用」的**全局** mcp/agent/plugin,是否仍被引擎加载(= 残留),取决于引擎在 alpha.jsonc 之外读取的源与其相对 alpha 的加载顺序。

### 引擎读取集与顺序

- **XDG 全局目录 = `(XDG_CONFIG_HOME || ~/.config)/opencode`**(`packages/core/src/global.ts:13`,xdg-basedir)。**固定**,不 honor `OPENCODE_CONFIG_DIR`(后者只进 directories 阶段,`config.ts:425-426`,且只读 `opencode.json`/`opencode.jsonc`,不读 `config.json`)。
- 加载序(`packages/opencode/src/config/config.ts`):
  1. **XDG 全局三文件** `config.json` → `opencode.json` → `opencode.jsonc`(`:258-260`,合并于 `:398`)—— **在 alpha.jsonc 之前**。
  2. **`Flag.OPENCODE_CONFIG`(= alpha.jsonc)**(`:401`)。
  3. 项目 `opencode.json(c)`(cwd walk)、`.opencode/*`、**`~/.opencode/opencode.json(c)`**(home-walk,`config/paths.ts:34-38`;不读 config.json)、`OPENCODE_CONFIG_DIR/*`、`OPENCODE_CONFIG_CONTENT`、active-org 远程、managed dir、MDM —— **均在 alpha.jsonc 之后**。

### 合并语义

- **mcp / agent** = `mergeConfig` = remeda `mergeDeep`(`config.ts:41-43`),later-wins 深合并;后源省略某字段则保留前源值。
- **plugin** = `mergePluginOrigins`(`config.ts:330-349`)= 跨**所有**源的 **union(按插件身份去重),顺序无关**(**不**是 `mergeConfigConcatArrays` 的数组语义 —— 那只并 `instructions`)。

### alpha 生产注入(`packages/ui-mac/src/main/sidecar.ts` injectAlphaConfig)

- 设 `OPENCODE_CONFIG = ~/.alpha/alpha.jsonc`(`:155-160`)+ `OPENCODE_CONFIG_CONTENT`(alpha 自身定制,`:381`)。
- **不设** `OPENCODE_CONFIG_DIR`;**不改** `XDG_CONFIG_HOME`(仅 onboarding 测试态改道,`index.ts:204-213`)。
- 故引擎照常读真实 `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}` 与 `~/.opencode/opencode.json(c)` —— 这是 legacy 复活面。

### 消费点

- mcp:`packages/opencode/src/mcp/index.ts:374,514` — `mcp.enabled === false` 跳过(`undefined` = 启用)。
- agent:`packages/opencode/src/agent/agent.ts:267-271` — `value.disable` truthy 则从 agent 表删除。

## 残留判定表

| kind | 合并 | before 源(XDG,alpha 之前) | after 源(`~/.opencode`/OPENCODE_CONFIG_DIR/项目,alpha 之后) |
|---|---|---|---|
| **mcp/agent** | mergeDeep 顺序敏感 | 主叶投影禁用时**被 alpha 覆盖 = 安全**;主叶缺席时按 last-set 参与 | 显式反向字段(`enabled:true`/`disable:false`)**能复活** → 残留 |
| **plugin** | union 顺序无关 | 任一源含同 base/身份 = **残留** | 任一源含同 base/身份 = **残留** |

## 探测器设计(`legacyEnableResidueStrict`)

- 文件集按 `engineXdgConfigDir()`(固定 XDG)+ `opencodeHomeDir()`(~/.opencode)+ OPENCODE_CONFIG_DIR(若设),标注 `phase: before|after`。
- **mcp/agent**:按加载序对 `enabled`/`disable` 顶层标量做 **last-set 追踪**(before → alpha 投影 → after),最终非禁用值 + 叶在场 = 残留。before 源被 alpha 覆盖不算残留(修 r7/r8 逐文件短路的 M1 误拒)。
- **plugin**:两 phase 任一源命中同 base(npm)/文件身份(path,身份不可判 fail-closed)= 残留。
- strict:任一源语法损坏/读不出/根非对象 → fail-closed。

## 教训

长 L 级 enforcement 票,「重实现引擎合并」的探测器必须先钉死引擎真实的**文件集 + 加载顺序 + 每键合并语义(mergeDeep vs union)+ 宿主注入的 env**,否则逐文件近似会连续多轮既漏(安全洞)又误拒(功能坏)。r7→r9 三轮 legacy 探测 churn 皆源于此。相关:[[req104-395-deferred]]、`docs/contracts/extension-install-ledger.md` §5。
