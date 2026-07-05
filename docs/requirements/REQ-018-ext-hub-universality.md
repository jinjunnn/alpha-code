---
id: REQ-018
title: 定制中心 v3-M1 通用化地基:安装账本 + 全类型卸载 + 重载引擎 + .alpha 双层落盘迁移 + MCP 密钥 file 化 + Agent tab
type: feature
priority: P1
status: verified
repo: A
created: 2026-07-04
sprint: 2026-07-04-s12-ext-hub-m1
source: designs/2026-07-04-extension-hub-v3-universal.md(§1–§4、§8 M1)
---

## 背景/证据
体检(设计文档 §1/§2)实锤 4 个 P0:① skill/agent/command 写盘后引擎实例缓存不重扫(`instance-state.ts:26-45`,无文件监听)→「创建成功」实为 placebo;② MCP `environment/headers` 明文进 opencode.jsonc(`ext-config.ts:106-122`),文案却称「入钥匙串」且路径误写 `~/.opencode`(`zh.ts:82`);③ 已安装真相只有 `mcp.status`(`use-extensions.ts:212-215`),skill/plugin/bundle/agent 装完失管;④ 落点全在共享 `~/.config/opencode`,与 ADR-019 `.alpha` 战略脱节、污染原生 opencode。

**拍板(2026-07-04)**:D1 全局桥 = `~/.alpha` 真源 + `~/.opencode/<类>` symlink 桥;D2 = 一次性迁移弹窗 + `ALPHA_LEGACY_INSTALL_ROOT=1` 逃生;D4 = 「插件」保名 + 澄清文案。

## 任务拆分(按实现优先级序)
1. **T1 安装账本(receipts)**:`~/.alpha/installs.json` + `<项目>/.alpha/installs.json`;receipt = `{id,type,scope,version,installedAt,files[]|configKey,origin}`;主进程读写 IPC + 守卫(复用 safeResolve/safeResolveInAlpha 模式)。
2. **T2 生效机制(免重启,2026-07-04 修订)**:安装/卸载动作自动调上游公开端点 `POST /instance/dispose`(项目级)/`POST /global/dispose`(全局级)→ 实例惰性重建重扫,**当前会话下一条消息即可用**(依据:`sdk.gen.ts:1927-1950/1344-1350`、`handlers/instance.ts:25`、系统提示与工具集每条消息重组);dispose 守卫(目标实例有进行中流式/云任务时延后);「待重载」态(receipts ⨝ SDK 差集)保留为**异常兜底显示**;sidecar respawn 降级为兜底(仅 ext bundle/注入内容变更/dispose 失效逃生);spike 子项:dispose 重建耗时、活跃 PTY/SSE 影响面、MCP 重连风暴实测。
3. **T3 `.alpha` 双层落盘 + 桥(文件通道优先)**:全局 `~/.alpha/{skills,agents,commands,plugins}` 真源;`~/.opencode/<类>` symlink 桥(目录已存在则退化逐文件链);**全局 MCP/plugin 的引擎侧持久化 = `~/.opencode/opencode.jsonc`**(home `.opencode` 是引擎 config 源;env 注入在 fork 时冻结、reload 读不到,故不用于安装物;**实现修订:不设 connectors.json,jsonc+receipts 即全部真相,避免双真相**);项目 scope 选择器 → `<项目>/.alpha/*` + `.opencode` 桥(REQ-004 已实证);项目级 MCP 写 `<项目>/.opencode/opencode.jsonc`(引擎原生)。
4. **T4 存量迁移(D2)**:检测根 A 中 alpha 写入物(receipts 无则按 catalog 名单+启发匹配)→ 迁移清单弹窗(可逐项勾选/整体跳过)→ 搬移 + 补 receipt;逃生 env 保持旧行为。
5. **T5 MCP 密钥 `{file:}` 化**:requiredEnvVars 值写 `userData/alpha-secrets/<VAR>`(0600 既有通道),config 只落 `environment:{VAR:"{file:…}"}`(引擎整文本替换已生产验证);**任何 config 文件不再出现明文密钥**;修正 zh/en 文案(路径 + 钥匙串表述)。
6. **T6 全类型已安装 + 卸载**:统一管理列表(类型/名称/scope/版本/状态点/操作);卸载按 receipt 精确移除(文件/configKey/symlink),确认弹窗列出将删内容。
7. **T7 Agent tab + 内容补齐**:catalog 增 agent 条目 schema 与安装链路(落 `.alpha/agents`);composer agent 选择器现状核实(缺则最小补,数据源 `app.agents()`);官方 4 条 Anthropic skill 资产打包进 `resources/skills/` + NOTICE 更新(吸收 D3)。
8. **T8 plugin 已装态 + 重载接入**:解析 config `plugin[]` ∪ receipts 判已装;「重启后生效」文案全部替换为「重载引擎后生效(约 2 秒)」。

## 验收标准
1. 四类(MCP/skill/agent/plugin)各过「**装 → 亮(引擎列表可见)→ 用(会话内实调成功)→ 卸(文件/配置净除)**」四步,真机录证([[visual-verify-required]]);
2. **免重启验收**:装 skill/agent/command/plugin(本地 JS)后**不重启任何进程**,当前已打开会话的下一条消息即可用(`app.skills()/app.agents()` 可见 + 会话实调成功);npm 型 plugin 首装允许下载等待但有诚实进度——placebo 路径与「重启后生效」文案全部消失;
3. 迁移完成后,全流程对 `~/.config/opencode` **零新增写入**(迁移弹窗真机走通,跳过路径也正确);
4. 全部 config 文件(全局/项目)grep 无 requiredEnvVars 明文值;
5. 卸载后 receipts、磁盘、config、引擎状态四处一致;
6. 单测覆盖:账本读写、迁移匹配、密钥 file 化、卸载清除、symlink 桥退化逻辑;
7. `bun run` typecheck + alpha-check 三关绿。

## 非目标
详情页/更新/导入(REQ-019)、云集成(REQ-020)、自动化(REQ-021)、tool 类型开放安装(ADR-006 预 bundle 铁律)、`~/.config/opencode` 内用户自有内容的接管(只迁 alpha 写入物)。

## 关联
吸收 D3、D4(已标 dup);B8 的具体实现路径(B8 保留为终态验收视角);REQ-006 O2 由 T7 兑现;实现 PR 时随附 ADR-014 修订(v3)+ ADR-019 修订(全局层 `~/.alpha`);A2 存量钉版本迁移(T1.5)可与 T4 迁移弹窗同场收掉(届时在 A2 行记账)。
