---
id: REQ-098
title: 扩展运行环境隔离：prod/beta/dev 可变状态分域 + updater 通道对齐 + 旧 ~/.alpha 兼容迁移
type: security
github_issue: https://github.com/jinjunnn/alpha-code/issues/209
repo: A
created: 2026-07-10
source: 2026-07-10 产品能力与路由/扩展所有权专项审计；用户要求拆为独立 REQ
---

## 背景

Electron `userData` 已按 App channel 分开，但扩展账本、`alpha.jsonc`、Skill、Agent、Plugin 和密钥引用仍共享 `~/.alpha`。因此 beta/dev 安装或启用的高权限扩展可能被 prod 读取。与此同时，beta 构建的发布 feed 与运行时 updater 的固定 `latest` channel 不一致。

必须明确区分：App 运行环境 `prod/beta/dev`、Registry 通道 `stable/preview/dev`、以及未来可选的用户策略 Profile。当前 P0 只处理 App 环境隔离，不顺带设计任意 Profile UI。

## 目标与交付

1. 定义唯一环境映射：`prod → stable`、`beta → preview`、`dev → dev`，并由 main 进程持有。
2. 将 config、receipts、grants、secret、enabled state、materialized generation 按 App 环境隔离；只有内容寻址且已验证的不可变 blob 允许共享。
3. 为现有 `~/.alpha/{alpha.jsonc,skills,agents,plugins,installs.json}` 设计版本化兼容迁移：首次只读导入、生成迁移 receipt、保留兼容视图与明确回滚标记。
4. 修正 beta updater，使构建发布 channel、运行时检查 channel 和环境根一致。
5. 处理旧 MCP secret 绝对路径：迁移后必须重新派生到当前环境，不得引用另一个环境的 `userData`。

## 验收标准

1. prod 与 beta 分别安装、启用同 ID 不同版本扩展后，config、receipt、grant、secret 和运行进程互不可见；共享 blob 时磁盘只保留一份不可变内容。
2. beta 只查询 preview feed，prod 只查询 stable feed；测试构造错误 feed 映射时启动/更新 loud 失败。
3. 旧布局迁移执行两次结果相同；中途崩溃可重试；用户手写文件不被覆盖或删除。
4. 回滚到迁移前版本时，旧布局仍可读；新版本再次启动不会重复复制或丢失状态。
5. macOS、Windows 的路径与 secret 引用均通过含空格、Unicode、跨盘符 fixture。
6. 自动化测试证明 renderer 不能伪造当前环境或读取其它环境 mutable root。

## 非目标

- 不在本项实现 CAS/seed pack（REQ-102）。
- 不实现任意命名用户 Profile、团队漫游或云同步。
- 不改变扩展 manifest/receipt schema（REQ-099）。
- 不安装或启用任何新第三方扩展。

## 依赖与激活条件

- 无产品代码前置，可作为 Extension v2 第一批 P0；与 REQ-099 的路径/schema 设计必须同场评审。
- 依赖顺序与 Sprint 承诺只在 GitHub 原生依赖和 Alpha Delivery 中维护。
