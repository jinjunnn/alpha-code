---
id: REQ-023
title: 扩展安装供给链:官方扩展全配置化 + 离线资产通道(vendored plugin/agent)+ 安装管线状态机
type: feature
priority: P2
status: archived
repo: A
created: 2026-07-04
sprint: 2026-07-04-s13-ext-hub-m2
source: 用户 2026-07-04 提出(配置化/下载地址/cache/pipeline);并入 S13 追加 track
---

## 背景/证据
用户问题:官方 skill/agent/plugin 应配置化;是否需要下载地址,避免网络差导致插件装不上;是否要 cache;从点「添加」到装完的 pipeline 是否要优化。

事实基线(2026-07-04 核):
- **catalog 已是配置驱动**(`alpha-catalog.json` installSpec:MCP 钉版命令 / skill builtinAssetKey / plugin npm 包名),缺口在覆盖面与字段。
- **Skill 离线已实现**:builtin 资产随 app 打包(`resources/skills/`),安装=本地复制,零网络——即"cache"的极致形态。4 条官方 skill 内容仍未打包(诚实失败,ADR-014 旧账)。
- **Plugin 是真缺口**:安装只写 `plugin[]` npm 包名,引擎实例重建时自行 npm 下载(`config.ts:437-456`)→ 中国区 egress 差即装不上;catalog `mirrorRegistry` 字段存在但**未接进引擎下载路径**(CN mirror env 只注入 MCP local command)。已核:引擎 `plugin[]` 接受**绝对路径 / file:// URL**(`config/plugin.ts:42-60`,设计文档 §1.3)→ 可离线装。
- **Agent 是真缺口**:catalog 无 agent 条目(只能创建),官方 agent 无供给通道;agent=纯 md 文件,可走 skill 同款 vendored 通道。
- **MCP 已治理**:钉版(A2)+ npx/uvx 原生包缓存 + CN mirror env;不重复建设。
- **pipeline 状态机已有设计**(v3 §5.2:未安装→依赖检查中→安装中→已生效/待重载/失败),REQ-019 T7 落反馈体系;缺"获取阶段"细分与进度提示。

## 决策要点(本需求钉死)
1. **离线优先 = vendored 资产,不自建 CDN/缓存服务**:官方推荐扩展的内容随 app 打包;远程 catalog/下载端点归 E10/REQ-020(C 仓);任意 npm 包缓存代理不做(YAGNI,npx/uvx 原生缓存已够)。
2. **plugin 离线安装通道**:官方推荐 plugin 预 bundle 为自包含 JS(ADR-006)进 `resources/plugins/<key>/`;安装 = 复制入 `~/.alpha/plugins/<name>/` + `plugin[]` 写**绝对路径**(经 `~/.opencode/opencode.jsonc` 文件通道)→ 全程零网络;npm@钉版(+mirrorRegistry)仅作社区插件/无 vendored 资产时的 fallback。卸载按 receipt.files 净除。
3. **官方 agent 进 catalog**:新增 agent 类 CatalogEntry + `AgentInstallSpec`(vendored md 资产),安装=复制入 `~/.alpha/agents/` + 桥,receipts 记账;与内置引擎 agent(build/plan)区分展示。
4. **catalog schema 增量**:`vendoredAssetKey?`(离线资产键)、`downloadUrl?`(V2 远程直链,预留不实现下载器)、plugin `hooks[]`/`tools[]` 元数据(详情页用,与 REQ-019 T3 同场落)。
5. **安装管线状态机可视化**(§5.2 落地,与 REQ-019 T7 合并执行):`依赖检查中 → 获取(本地复制/下载中) → 写入配置 → 重载引擎 → ✓已生效`;每步失败行内(卡片 chip/详情 Banner)+ 重试;网络型获取显示"下载中,首次较慢"提示;toast 只报成功。

## 任务拆分
1. **T1 catalog 配置化补全**:agent 类目 + AgentInstallSpec;`vendoredAssetKey`/`downloadUrl` 字段;plugin 条目 hooks[] 元数据(tools[] 随 REQ-019 T3 一并补录)。
2. **T2 plugin/agent 离线资产通道**:`resources/plugins/` 预打包 opencode-notify(MIT 可再分发,记 NOTICE);主进程 installVendoredPlugin(复制+绝对路径写 plugin[]+receipt.files);官方 agent 资产 ≥1 条(如 code-reviewer 权限档示例)同通道;npm fallback 保留。
3. **T3 安装管线状态机**:卡片/详情页安装状态细分(检查中/获取中/写入/重载/生效),失败行内+逐步重试;与 REQ-019 T7 合并为一个 PR 面。

## 验收标准
1. **断网实测**:官方 plugin(vendored)从点「添加」到引擎生效全程成功(真机,关 Wi-Fi);
2. 官方 agent 条目出现在 Agent tab、可安装可卸载(receipts ⨝ SDK 一致);
3. catalog schema 新字段就位,plugin hooks[] 详情页可见;
4. 安装状态机各阶段在 UI 可见,失败行内呈现且可重试,零裸失败 toast;
5. 卸载按 receipt.files 净除 vendored 落盘物,`~/.config/opencode` 零残留。

## 非目标
自建远程 CDN / 下载端点(→ E10/REQ-020,C 仓);任意 npm 包缓存代理;MCP server 包预打包(体积不可控,npx/uvx 缓存已够);第三方/社区插件的离线化(仅官方推荐清单)。

## 关联
并入 [sprints/s13](../sprints/2026-07-04-s13-ext-hub-m2/sprint.md) 追加 T9;依赖 REQ-018(账本/桥/dispose);与 REQ-019 T3(元数据)/T7(反馈)同场;ADR-006(预 bundle)/ADR-019(~/.alpha 真源)/B15(NOTICE);D5 vendored 内容安全教训(PR #73)适用。
