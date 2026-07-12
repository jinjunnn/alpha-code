---
id: REQ-102
title: 扩展 CAS 与离线 Seed：media-type-neutral blob + release lock + GC
type: feature
github_issue: https://github.com/jinjunnn/alpha-work/issues/5
repo: X
created: 2026-07-10
source: 2026-07-10 路由与扩展生态所有权专项审计；用户要求拆为独立 REQ
---

## 背景

当前远程资产下载后直接写目标目录，无法跨环境复用、原子更新或稳定回滚；App 内置快照依赖人工同步。用户希望“缓存预装”，但缓存绝不能等于安装、启用或运行。

## 目标与交付

1. 实现 main-owned content-addressed store：manifest、blob、展开 tree、quarantine；blob 由 digest 定位，archive 格式由 mediaType 声明，不硬编码 `.tar.zst`。
2. App 通过 `<process.resourcesPath>/extension-seed` 提供只读 seed lock、manifest、可再分发 blob 与 NOTICE/SPDX 信息。
3. 可获得性 `remote/bundled/cached` 与激活态 `not-installed/installed-disabled/enabled/running` 正交；读取 seed 不产生配置写入、进程或网络。
4. release CI 从 stable targets 生成 seed；`redistributable=false`、许可证/NOTICE 缺失、平台不兼容或体积预算超限立即失败。
5. 不复制整个 seed；用户选择安装时才把所需 blob 提升到用户 CAS/materialization pipeline。
6. 实现 mark/sweep GC：current、previous healthy、pinned、project receipt、未完成 transaction、seed target 和未来 running lease 均保留。

## 验收标准

1. fresh offline 安装可浏览 seed；除明确第一方核心外所有第三方均默认未启用、无进程、无网络、无 config 写入。
2. prod/beta/dev 引用相同 payload 时磁盘只有一个 blob；环境 receipt/grant/current 仍完全隔离。
3. 相同 source 构建两次得到相同 digest；路径遍历、symlink、大小/文件数超限、digest 不符在展开前拒绝。
4. 删除 App 或清理缓存不会删除用户创建内容、secret、原始导入源和 current/previous/pinned generation。
5. seed lock 与线上 stable snapshot 漂移时 release CI 失败，不再依赖发版者手工记忆。
6. Windows/macOS 的 resourcesPath、长路径、并发读写与磁盘不足场景有自动化覆盖。

## 非目标

- 不把浏览器、Office、UI-TARS 等重运行时放进默认 seed。
- 不默认缓存所有 npm/uvx runtime 或第三方 engine plugin。
- 不在本项实现 Registry metadata（REQ-101）或安装事务（REQ-100）。

## 依赖与激活条件

- 硬依赖 REQ-098、099、100、101。
- 独立 `alpha-registry` 新仓不是启动前置；先在现有作者真源建立可迁移 release unit。
- **激活阈值（2026-07-12 评审拍板，用户采纳）**：与 [[REQ-101]] 挂同一分发规模阈值门（硬依赖链含 101，101 已 parked-with-trigger，本项随之顺延）。触发前「缓存预装 / 离线可用」诉求由现行通道覆盖：A 内置签名快照（ADR-023 修订通道）+ vendored 随包资产。详见 owning Issue（jinjunnn/alpha-work#5）2026-07-12 评注。
