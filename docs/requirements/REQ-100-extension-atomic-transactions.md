---
id: REQ-100
title: 扩展原子事务：staging/materialization + Bundle 锁 + 健康探测 + rollback/quarantine
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/211
repo: A
created: 2026-07-10
source: 2026-07-10 产品能力与路由/扩展所有权专项审计；用户要求拆为独立 REQ
---

## 背景

当前 Skill 更新会覆盖旧目录并残留新版已删除文件；Plugin 更新可能先卸旧再装新；Bundle 按顺序安装，失败后可留下半成品。receipt 也无法表达并存版本、previous healthy 或事务恢复。

## 目标与交付

1. main 进程实现安装 transaction：plan → staging → digest/compat/grant 校验 → materialize generation → health probe → atomic switch → receipt commit。
2. Bundle 在写盘前解析完整依赖图，child 固定 `id + version + manifestDigest`；一次展示 capability diff、一次授权、一次 commit。
3. 更新不得在旧目录原位覆盖；新版缺失文件在新 generation 中自然消失。
4. MCP/engine plugin 执行类型提供类型化 health probe；失败自动保留 current 并隔离失败 generation。
5. 支持 previous healthy rollback、崩溃恢复、transaction journal 与 quarantine；撤销状态优先于 receipt。
6. 运行中的 MCP/plugin 第一阶段至少不热重载；per-session digest lease 留给后续 runtime 能力。

## 验收标准

1. 在下载、解包、写文件、配置生成、dispose、health、receipt commit 各阶段注入故障，均不存在半装态；重启后自动恢复或清晰提示可重试事务。
2. Bundle 任一 required child 失败时 current generation 完全不变；optional child 的跳过在授权与 receipt 中可见。
3. 更新删除旧文件后无残留；更新新增 capability 时必须重新确认，拒绝后旧版继续健康运行。
4. MCP/plugin health 失败自动回旧 generation；用户可离线回滚至少前两个健康版本。
5. 并发安装/卸载同一扩展由跨进程锁串行化，不损坏 receipt 或配置。
6. 卸载只删除 transaction/generation 拥有的路径，不删除用户手写文件和原始导入源。

## 非目标

- 不在本项决定 blob 存储格式或 seed（REQ-102）。
- 不实现 Registry 签名、channel promotion（REQ-101）。
- 不自动启用任何缓存扩展。

## 依赖与激活条件

- 硬依赖 REQ-099 的 manifest、scope 与 receipt v2。
- 与 REQ-102 的 CAS 接口预留 digest 边界，但可先用普通 staging 目录独立完成事务语义。
