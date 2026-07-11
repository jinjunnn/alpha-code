---
id: REQ-099
title: Extension Manifest/Receipt v2：严格 schema + main-only 安装计划 + 项目作用域闭环
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/210
repo: A
created: 2026-07-10
source: 2026-07-10 产品能力与路由/扩展所有权专项审计；用户要求拆为独立 REQ
---

## 背景

当前远程 Skill/Agent 已采用 main 按 catalog ID 重新派生的较安全路径，但 MCP、npm plugin、builtin/vendored 安装仍存在 renderer 传入实际配置、包名或路径的信任差异。Catalog 主体只做浅层结构检查；receipt 无稳定的项目 identity、manifest digest、grant digest 和 previous generation，Hub 也主要读取 global view，导致项目资产管理不闭环。

## 目标与交付

1. 定义严格的 `ExtensionManifestV2`：kind、版本、artifact digest/size/mediaType、compatibility、capabilities、dependencies、五维 ownership 与 support tier。
2. `manifestDigest` 放在签名 target/descriptor/receipt，不放进被自身哈希的 manifest；运行位置使用数组或逐组件声明。
3. renderer 的 catalog 安装请求收窄为 `manifestDigest + scope + requestedGrants`；main 验签、严格解码并重新生成完整安装/卸载计划。
4. 自定义 MCP/npm/git/folder 安装走单独的“未策展来源”入口、风险文案和 receipt，不复用 Catalog 的可信语义。
5. 定义 `InstallRecordV2`：环境、scope identity、版本、manifest/payload digest、channel sequence、grant digest、desired state、generation、previous digest、transaction 与时间。
6. Hub 按当前 project context 读取、展示、禁用、更新和卸载项目 receipt；main 根据受控根和 digest 重新派生 owned paths。

## 验收标准

1. 缺字段、未知顶层键、非法 digest、越权 capability、循环依赖、平台不兼容 manifest 均在写盘前拒绝并给出可定位错误。
2. 测试伪造 renderer package/command/config/receipt/绝对路径，main 均忽略伪造事实并按已验 target 重建计划。
3. global 与两个不同项目安装同名扩展，Hub 能分别显示、禁用、卸载；任何一项操作不影响其它 scope。
4. 项目被移动、路径含 Unicode/符号链接、receipt 损坏时 fail closed，不退化为 global 卸载。
5. 所有权 UI 能同时显示 authored、curated、distributed、runtime surfaces 与 support tier，不把 Alpha curated 误标为 Alpha authored。
6. v1 receipt 有显式迁移/只读兼容策略；升级与回滚测试不丢现有安装。

## 非目标

- 不在本项实现事务化 materialization、健康探测或 rollback（REQ-100）。
- 不实现 signed channel metadata（REQ-101）或 CAS（REQ-102）。
- 不实现完整 Claude plugin 转换（REQ-034）。

## 依赖与激活条件

- 与 REQ-098 的环境 root 和旧布局迁移共同设计；两者可以分 PR 实施，但 schema/path 必须先联合评审。
- 架构开工前应建立或修订 Extension Package/Registry v2 ADR，并关联 ADR-014/023/024。
