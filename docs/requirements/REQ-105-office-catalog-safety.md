---
id: REQ-105
title: Office Catalog 安全纠偏：归档 Word/PPT 下架 + Excel 精确锁版与本地沙箱
type: security
github_issue: https://github.com/jinjunnn/alpha-work/issues/7
repo: X
created: 2026-07-10
source: 2026-07-10 当前生态复核；REQ-080 发货后风险发现；用户要求拆为独立 REQ
---

## 背景

REQ-080 上架的 Office Word 与 PowerPoint MCP 上游已于 2026-03-03 被作者归档。Excel MCP 曾有路径遍历/未认证远程读写安全公告，0.1.8 修复。已 shipped 的 REQ-080 必须保留交付历史；本需求作为独立纠偏，不篡改旧结论。

## 目标与交付

1. Word/PPT MCP 移出 stable recommended、precache 与默认 Office bundle；如保留发现能力，只能进入带 archived/unsupported 警告的 legacy optional 区。
2. Excel 固定到经本轮审计的确切版本（起点可为修复公告的 `0.1.8`），升级必须重新 intake；不得使用 `>=` 或漂移版本。
3. Excel 仅允许 local stdio + workspace sandbox，禁止监听 `0.0.0.0` 或未认证远程 transport；详情页显式展示文件写权限。
4. 同步更新 C 端签名 Catalog、A 端离线快照/seed lock 与 bundle child locks；旧客户端的可见性和已安装用户处置写入发布说明。
5. 给 REQ-080 追加“发货后风险发现”注记并阻止其在纠偏前翻 verified；不重写 shipped 记录。

## 验收标准

1. 线上 stable Catalog、fresh App 离线快照和 Office bundle 均不再推荐/预缓存归档 Word/PPT。
2. Catalog/receipt 显示 Excel 确切版本和 digest；升级不 bump 审计记录时 CI 失败。
3. 自动化测试拒绝 Excel TCP/HTTP `0.0.0.0` 配置、workspace 外路径与 traversal fixture；local stdio 正常创建一个测试 xlsx。
4. 已安装 Word/PPT 用户不会被静默删除；Hub 显示 archived + unsupported、禁自动更新并提供可审计卸载路径。
5. Catalog 版本、签名、A 内置快照和 bundle 锁一致；远程与离线回退不会重新露出推荐卡。
6. REQ-080 的历史证据链接本纠偏 owning Issue；不再向 BACKLOG 写入状态。

## 非目标

- 不在本项开发替代 Word/PPT writer。
- 不实现 Office 应用内预览或视觉正确性流水线（REQ-097）。
- 不引入 Anthropic Office Skills。

## 依赖与激活条件

- 无架构前置；优先级和 Sprint 承诺只在 Alpha Delivery 管理。
- 跨 A/C 两仓交付；发布顺序必须保证远程 Catalog 先安全下架，再刷新 A 离线快照。
