---
id: ADR-014
title: 定制中心 — Skills/MCP/Plugins 可视化市场,采用 Claude 三分法 + alpha 自建套件,零-fork 安装
status: accepted
date: 2026-06-22
related: [ADR-002, ADR-003, ADR-006, ADR-008, ADR-009]
---

> **2026-07-05 v3 转 accepted**(REQ-016 S16 桌面真机批,证据 [audits/2026-07-05-req016-realmachine-batch/verify.md](../../../docs/audits/2026-07-05-req016-realmachine-batch/verify.md)):prod 签名+公证包实测 —— skill/MCP/agent/plugin **四类 in-app 安装→免重启桥(`~/.alpha` 真源 + `~/.opencode/<类>` symlink)→已安装态→卸载净除**全通;vendored 插件字节级零网络(与打包资产一致);A6 env dump 证第三方 MCP 子进程零密钥泄漏(解 R3 门控)。**转正过程中发现并修复 P1 真机 bug**:已安装 tab 卸载/更新对账本条目静默失败(Solid store Proxy 未 unwrap 过 contextBridge → 结构化克隆抛错被 void 吞),修复见 `use-extensions.ts` + 回归锁测。剩余真机项(迁移开门/卸 uv 像素/git 真克隆/dispose 打断)为增强验证,不阻断转正。

> 配套设计:`docs/design/2026-06-22-arch-extension-hub.md`(v2,经 /app:design-arch);build:见 [GitHub Issues](https://github.com/jinjunnn/alpha-code/issues) 与 [Alpha Delivery](https://github.com/users/jinjunnn/projects/2)。
> 状态 `trial`(2026-06-22):design-arch 完成 → 用户选 A→design→C(跳过 plan-review)→ MVP 已实现(Phase ①②③⑤⑥,Plugin 门控)并 typecheck+build 通过。**待 Mac 端像素核验 + Phase ④ 后转 `accepted`。**

## 背景
侧栏「插件」(`ui-mac/.../alpha-sidebar.tsx:494`)只触发 `mcp.toggle`(opencode 的 MCP 开关对话框)—— 名不副实,且不覆盖 skill/agent/command/plugin;「自动化」是死占位。要做"完整成熟的 skill/agent/command/plugin 生态",但源码核实出三条硬约束:① opencode 的 `plugin` 不是能打包多件的"伞",只有 3 个 hook(`core/src/plugin.ts:23-48`);② 全平台无任何内置 marketplace/registry;③ MCP 的 `POST /mcp` 只在内存生效、不落盘(只有 CLI 写 config)。

## 决策(全部落 alpha 自有文件,零改 upstream)
1. **IA 采用 Claude 三分法**:技能(Skill)/ 连接器(MCP)/ 插件(Plugin),1:1 映射 opencode 三原语;侧栏「插件」改名 **「定制中心」**,内含三分 tab + **套件** + **已安装(可启停)** + **创建/导入**。术语按中国区本地化(连接器/套件/已安装)。
2. **"套件(bundle)" = alpha 自建 manifest**(非 opencode plugin),安装时**扇出**成多个原子安装 —— 因为 opencode plugin 不能 bundle 其它类型(约束①)。
3. **目录(catalog)自备**:内置进 app 一份 `catalog.json`(离线优先,躲中国区 npm/pip/GitHub egress),可选从 alpha-web(C)增量刷新 —— 因为无内置 registry(约束②)。
4. **零自建引擎 — live SDK + 薄 IPC 持久化**:经 Round2 对抗推翻"需自建安装引擎"假设(F3 证实 SDK 有 `mcp.add`,持久化仅需复用 CLI `addMcpToConfig` ~30 行)。新增唯一 IPC 方法 `window.api.ext.persistMcp()`(主进程写用户 opencode.jsonc 的 mcp[name])+ SDK `mcp.add`/`connect`(当场生效,免重启)。**已安装真相 = SDK 源**(mcp.status),UI 偏好用既有 window.api.store(非另起 electron-store)。出厂预设经既有 F8 的 `injectAlphaConfig`(`OPENCODE_CONFIG_CONTENT` merge)注入,`ALPHA_EXT_PRESET_DISABLE` 逃生开关。
5. **Office/PDF 做成「办公套件」、以 MCP 为主**(markitdown 读 + openpyxl 系 Excel-MCP 写 + 自写引导技能),**不裸搬 Anthropic 文档技能**(源码可见、禁止再分发,且依赖 LibreOffice/pandoc 太重)。可再分发的:Anthropic Apache-2.0 example-skills、官方 MCP、markitdown(MIT)、飞书/钉钉/语雀官方 MCP。
6. **create/import 要做**(分期):创建技能/Agent(表单,可接 `skill-creator`)、导入 folder/git-url/npm。
7. **运行时依赖预检** — MCP 装前检 `which uv` / `which python`,缺失诚实提示(不装);MVP 优先 remote-command/sse 可假定运行时的 MCP,避免本地工具链鸿沟。
8. **IPC 安全边界(防逃逸+配置注入)**:写路径白名单(仅 ~/.opencode,realpath 防符号链接)、字段白名单(仅 mcp[*] 白名单字段)、命令白名单(uv/node/python/bun + /opt/homebrew/bin/*)、URL 白名单(仅 https,开发模式允许 localhost)、token 不硬编码(走 keychain,占位)。
9. **MVP 收窄为 MCP-first 连接器**:初稿全量(skill/agent/plugin/mcp)被 Round2 指出过度工程(~11 组件+12 实体→冲突薄定制层 <5%);v2 删引擎后 MVP 仅 MCP 楔子(浏览+一键装+持久+toggle+依赖预检,内置 3-5 条);skill/plugin/create/import 整体降级 V1+ roadmap。**先验证"有人用 MCP"再扩**,避免返工。

## 后果
- ✅ 把死胡同入口升级为 MCP 优先的完整扩展楔子;零改 upstream(北极星 = 冲突 0 不破);不靠 `experimental.*`(NON_GOALS#4)、不绕 SDK(#5);属"薄定制层"(从初稿 ~11 组件+12 实体砍到 v2 ~5 组件+3 核心实体)。
- ✅ 复用既有 `injectAlphaConfig` 注入接缝做预设;SDK 真相源(mcp.status)代替持久存储;MCP 一键装可免重启;零新工程成本(IPC+CLI 复用)。
- ✅ **v2 瘦身成果**(经 design-arch Round2):删 electron-store → SDK 真相源;删 InstallJob/queue → UI 临时状态;删自建引擎(C6–C9) → CLI addMcpToConfig 复用;删 skill/plugin/create 进 MVP → 整体降 V1+ roadmap;改全屏 Portal → 覆盖内容区(z 序/focus 冲突化解)。
- ⚠️ "MCP catalog/镜像感知安装"是净新增维护面(对策:先内置 3-5 条、小而精);plugin 装包需重启 + 中国区 egress(对策:内置资源 + V2 npmmirror);新增主进程 IPC 写 config = 新攻击面(对策:§4 的路径/字段/命令/URL 白名单)。
- 🔭 待 plan-review 确认:① MVP 是 MCP-first(本设计)还是全量;② Agent/Command 进市场 tab 否;③ F9 串台默认开关;④ 远程 catalog 是否依赖 alpha-web(C)。
- 修订:2026-06-22 经 design-arch Round1/Round2 瘦身,产出权威设计 `docs/design/2026-06-22-arch-extension-hub.md`(v2)。
- 修订:2026-06-23 — 核实实现已超本 ADR 所述 MVP:**create skill/agent 表单 + plugin 安装实际已发**(commit `59c0786`,非"降级 V1+ roadmap")。本次补齐 V1+ roadmap 的 **builtin-skill 安装(E1b)**:`resources/skills/<key>` 资产 + electron-builder `extraResources` + 主进程 `installBuiltinSkill`(按 `builtinAssetKey` 复制进用户 scanned skills 目录,白名单+防逃逸)+ IPC/preload/渲染层全链路;种 2 条 alpha 自写 MIT 技能(`alpha-upstream-sync`/`safe-refactor`)。官方 4 条 Apache-2.0 仍待内容打包(现诚实失败,非占位)。详见 [GitHub Issues](https://github.com/jinjunnn/alpha-code/issues) 的 E1b。
- 修订:2026-06-24 — 新增**浏览器自动化连接器**(backlog E14):catalog 加 `mcp:playwright`(`npx -y @playwright/mcp`,Apache-2.0,Microsoft 官方,`category:dev`),补 `webfetch` 抓不动 JS 动态站点的能力缺口。**零代码新增**——安装/预检/持久/启停链路全复用既有(`npx` 已在命令白名单)。决策:本地 `npx` 优先 + **仅定制中心可装(不进 `injectAlphaConfig` 预设)**。未决项留 `_verify`:首次 navigate 的浏览器内核来源(Chromium 下载 vs `--browser chrome` 复用系统),`runtimeDep` 仅 which node、内核为运行时下载 → 待 A6 桌面实测拍板。**给用户的浏览器面板(Phase B)不在此 ADR,单独走定位关。**

## 修订(2026-07-04,v3 —— 全类型通用化,S12/REQ-018,权威设计 `docs/design/2026-07-04-extension-hub-v3-universal.md`)
体检发现 MVP「MCP-first + SDK 唯一真相源」的通用性只对 MCP 成立:skill/agent/plugin **装完不生效**(引擎实例缓存无文件监听)、**装完失管**(mcp.status 只认 MCP)、落盘污染共享 `~/.config/opencode`、MCP 密钥明文进 jsonc。v3 修订本 ADR 的四条核心决策:

1. **安装真相源:SDK → receipts ⨝ SDK**(修订原 §4「已安装真相 = SDK 源」)。新增安装账本 `~/.alpha/installs.json`(alpha-installs.ts),覆盖 skill/agent/plugin 的「已安装/卸载/更新」真相;MCP 仍以 SDK `mcp.status` 为实时态,receipts 记 provenance。**放弃「零持久存储」**(v2 删 electron-store 的理由是不复制 SDK 已有真相;fs 类 SDK 无对应真相,故账本是必要新增,非过度工程)。
2. **落盘根:`~/.config/opencode` → `.alpha` 双层 + `~/.opencode` 桥**(ADR-019 修订配套)。全局 `~/.alpha/{skills,agents,plugins}` 真源 + `~/.opencode/<类>` symlink 桥(引擎原生扫描,REQ-004 实证);MCP/plugin 引擎侧持久化改写 `~/.opencode/opencode.jsonc`(**文件通道**,env 注入在 fork 冻结、reload 读不到);存量一次性迁移(门控 `ALPHA_MIGRATE_ENABLE`)。
3. **生效机制:免重启(dispose)**。新增决策——安装/卸载后调上游公开 `POST /instance|global/dispose` → 实例惰性重建重扫,**当前会话下一条消息即可用**(实测 8ms dispose + ~101ms 重建,[audits/s12-verify](../../../docs/audits/2026-07-04-s12-ext-hub-m1-verify.md))。取代 v2「mcp.add 免重启、其余需重启」的不对称。
4. **MCP 密钥 `{file:}` 化**(补强 §8 安全):requiredEnvVars 密文采集 → `alpha-mcp-secrets/<server>/<VAR>`(0600,A6 同机制),config 只落引用。修正此前「根本没采集密钥值」的缺陷 + 「入钥匙串」失实文案。

**O1–O4 拍板**(REQ-006 未决项,随本修订钉死):O1 MVP 范围=**全类型通用化**(如实取代「MCP-first」表述);**O2 = Agent 进 tab(是)、Command 不单列**(自动由 skill/MCP 生成,详情页说明);O3 F9 串台=不在 M1(维持默认);O4 远程 catalog=依赖 alpha-web(E10,REQ-020,C 端点未建前离线优先内置)。**术语拍板(D4)**:「插件」保名(引擎语义 = hooks+工具的 JS 模块,装不了 skill/agent),tab 副标题 + GLOSSARY 澄清「插件 vs 套件」。

**状态**:仍 `trial`。转 `accepted` 的剩余门 = **桌面真机批**(登录态 in-app 四步 ×4 类 + A6 env dump 解 R3 + 迁移开门,REQ-016 同场);引擎级四步端到端已 PASS(见 audits)。分期后续:M2 详情页/更新/导入(REQ-019)、M3 云能力进 hub(REQ-020)、自动化(REQ-021)。

## 修订(2026-07-04 晚,M2 shipped —— REQ-019/REQ-023,PR #74-#77)

1. **IA 终稿 = 横向 9 tab(用户拍板,否决 v3 修订稿的左栏分区)**:推荐/连接器/技能/Agent/插件/套件/已安装(角标=可更新数)/创建/云能力占位;有更新并入已安装、导入并入创建;交互定稿 `docs/design/2026-07-04-ext-hub-m2/design.html`(视觉语言 = 6-26 稿 token 零改动)。v3 §「IA 从三分法+7 tab 改左栏分区」表述由本条取代。
2. **详情页(类目内下钻)**:点卡片主体 → 详情(tab 保持高亮,「‹ 类目名」返回,Esc 逐级);通用头部(来源/许可证/版本/`_verify` 显式「待核实」+ 主操作在头部右侧)+ 逐类型区块(MCP tools[] 精选清单/技能 SKILL.md 全文/Agent 权限档+提示词预览/插件 hooks+D4 澄清+风险/套件组合清单逐项安装);数据边界如实(本地命令型不谎称不出网);进页即实时 which 依赖检测。
3. **「添加」三档分流**:技能=直装(零配置);MCP/套件=确认框(密钥密文采集/组合清单);插件与目录 Agent=详情页先行(插件带「运行于引擎进程」风险确认)。
4. **生命周期补全**:更新通道(receipts.version < catalog.version → 角标+分组,fs 覆盖重装 / plugin 换钉版 / MCP 确认框重装防丢 {file:} 引用);导入 folder/git/npm(frontmatter 校验、https-only 浅克隆、外来内容不执行,origin=imported)。
5. **供给链(REQ-023 并入)**:catalog 增 `vendoredAssetKey`/`downloadUrl`/`AgentInstallSpec`/`tools[]`/`hooks[]`;官方 agent(code-reviewer 只读档)与 vendored 插件(opencode-notify 自包含 JS,不再分发原生通知器)随 app 打包;vendored 安装 = 复制 `~/.alpha/plugins` + `plugin[]` 绝对路径(persistPluginPath 限树内)= **零网络**;卸载净除(config+文件+账本)。不自建 CDN(远程 catalog 仍归 E10/REQ-020)。
6. **状态**:转 `accepted` 的真机批清单更新 = S12 残余 + S13 递延(卸 uv 像素、断网 vendored 走查、git 真克隆、dispose 打断活跃流、打包件含 resources/{agents,plugins} 且公证不受影响),见 `docs/audits/2026-07-04-s13-acceptance.md`。

## 修订(2026-07-07,REQ-059 —— 持久化真源改 `~/.alpha/alpha.jsonc`)
v3 修订①③所述「MCP/plugin 引擎侧持久化 = `~/.opencode/opencode.jsonc`(文件通道)」更新:真源迁 `~/.alpha/alpha.jsonc`;引擎可见通道 = `OPENCODE_CONFIG` 原生 additional-config 合并 / ext 插件 `config` hook(同日晚追加拍板:**全面零 `.opencode`**,不再有任何指针/桥,per-route 由 T0 spike 裁定)。dispose 免重启语义、「receipts ⨝ SDK」真相源不变。机制/迁移/所有权判定见 [[ADR-019]] 同日修订(含补充)与 [[REQ-059]]。

## 修订(2026-07-19,#428 —— 全局安装面改为环境级 canonical 根)

本 ADR 早期修订中的全局 home `.alpha` 路径仅保留为历史决策记录，现行安装、账本、配置与
自动化真源一律位于 `<appData>/alpha-code-state/env/<environment>`；共享 CAS 位于兄弟目录
`<appData>/alpha-code-state/cas`。desktop 唯一初始化并派生 canonical `ALPHA_GLOBAL_DIR`，各写入
批次在动作前复验根身份。退休 home 根不读、不写、不迁移、不 dual-read；它的等值、祖先、后代
和 symlink alias 均拒绝。项目级 `<project>/.alpha` 不受本修订影响。
