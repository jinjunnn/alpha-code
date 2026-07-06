---
id: REQ-045
title: 撤下条目远程补货:mcp-builder/canvas-design/brand-guidelines 经远程 catalog 上架
type: feature
priority: P3
status: verified
repo: C
created: 2026-07-06
sprint: S26
source: S22(REQ-044 ②)撤条目时的补货承诺
---

## 背景/证据
S22(PR #119)把 catalog 里三个 builtinAssetKey 资产从未随 app 打包、安装恒失败的条目撤下(`skill:mcp-builder` / `skill:canvas-design` / `skill:brand-guidelines`),连带撤空壳 `bundle:design`、给 `bundle:dev` 摘成员。撤下时钉死补货正道 = **远程 catalog(REQ-032 管线)**:资产就绪后经 C 侧(alpha-web)上架,**A 零发版**。本条登记该补货工作,防止意图丢失。

## 验收标准
1. 三条 skill 资产内容就绪:来源核验(Anthropic Apache-2.0 example-skills 允许再分发)+ NOTICE 随资产;
2. 经 alpha-web `build-catalog.mjs` 发布:catalog 条目 + `downloadUrl` 不可变资产 + sha256 钉死 + ed25519 签名(复用 REQ-032 全链);
3. A 侧**零发版**验证:远程刷新后条目出现在定制中心、安装成功、账本 origin 记远程来源;
4. (可选)`bundle:design` 若成员齐再回归,不齐不复活空壳。

## 非目标
- 不把资产重新打进 app 包(S22 已拍板:内置通道对此三条关闭);
- 不新增分发基础设施(REQ-032 管线已 prod)。

## 关联
[[REQ-044]](撤下动作)· [[REQ-032]](远程分发管线)· D3(历史:官方 skills 打包意图,dup→REQ-018 后未兑现,本条为其远程路线复活)。

## 结果(2026-07-06,S26 shipped)
- 验收①②④ 已落(alpha-web PR #10,已部署 prod):来源 = anthropics/skills@`9d2f1ae`,三条 LICENSE.txt 逐条核验 Apache-2.0,NOTICE.md(仓库/钉 commit/改动声明)随资产,canvas-design 字体 SIL OFL 1.1 许可文本随字体;catalog 2026-07-06.2,98 文件 sha256 + ed25519;prod 复验验签 VALID、抽样下载 sha256 全匹配;bundle:design 成员齐回归、bundle:dev 补回 mcp-builder。
- 验收③ **verified(2026-07-06,S27 真机批)**:签名包 hub 三条目远程下发可见 → 安装四要件 + bundle:design 扇出首例全过([audits/vnext3](../audits/2026-07-06-realmachine-vnext3/verify.md))。
- 细节:[sprints/2026-07-06-s26-req045-restock](../sprints/2026-07-06-s26-req045-restock/sprint.md)。
