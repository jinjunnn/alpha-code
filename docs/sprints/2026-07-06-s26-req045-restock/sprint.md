# Sprint 2026-07-06 S26 —— REQ-045 撤下条目远程补货(纯 C 侧)

> **抽取(2026-07-06,用户拍板)**:REQ-045(feature,仓=C)。用户裁决「先 REQ-045(C 侧上架三条 skill 资产,顺便当 REQ-046 的真实演练),再攒真机批一次清单」。上批 S25(B16)已收尾(A PR #123 + alpha-web PR #9),WIP=1 满足。
> **背景**:S22(PR #119)撤下三条 builtinAssetKey 资产从未随包、安装恒失败的条目(`skill:mcp-builder` / `skill:canvas-design` / `skill:brand-guidelines`)+ 空壳 `bundle:design`,钉死补货正道 = REQ-032 远程资产管线(A 零发版)。
> **纪律**:REQ-046 单侧作者动作(唯一作者源 = alpha-web `catalog-src/`,A 仓零动作);Apache-2.0 来源核验前置;不可变版本目录;A 侧安装验证归真机批。

## Task 表

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T1 | 来源核验 + 资产入库:钉 anthropics/skills@`9d2f1ae` 拉取三条 skill,逐条核验 LICENSE.txt = Apache-2.0;拷入 `catalog-src/assets/skill.<name>/1.0.0/`;各附 NOTICE.md(仓库/钉 commit/许可/改动声明);canvas-design 字体 SIL OFL 1.1 许可文本随字体 | 验收①:三条资产就绪 + 来源核验 + NOTICE 随资产 | ✅ |
| T2 | catalog 上架:三条目 `source:"remote"` v1.0.0(displayName/description/category 复用 S22 撤架前原文)+ `bundle:design` 成员齐回归 + `bundle:dev` 补回 mcp-builder optional 成员 + 顶层 version → 2026-07-06.2 | 验收④:bundle 不复活空壳(成员齐才回归) | ✅ |
| T3 | 构建 + 本地模拟 A 侧验证:`build-catalog.mjs`(sha256 + ed25519 + 不可变落盘)→ 内置公钥验签 / 98 文件 sha256 / frontmatter name 守卫 / 5MB 单文件帽 | 验收②:REQ-032 全链复用,全绿 | ✅ |
| T4 | 发布:alpha-web PR #10 → merge → `deploy/deploy.sh` → prod 端点复验(验签 VALID + 三条目在场 + 抽样下载 sha256 匹配) | prod 即时生效,联网用户可见 | ✅ |
| T5 | 回写:BACKLOG REQ-045 翻 shipped · 需求档 frontmatter · CHANGELOG [Unreleased] · sprint 契约 | 四件套齐 | ✅ |

## Gates
- C 侧构建脚本自带不可变守卫(已发布版本改动即拒),本批全部为新版本目录 → 无冲突;
- A 仓**零代码改动**(本 sprint 仅 docs 回写)→ alpha-check 照常;
- 真机递延(REQ-045 验收③ = verified 门):A 端远程刷新 → 三条目出现 → 安装成功 → 账本 origin 记远程来源;bundle:design 一键装(远程成员扇出)→ 下一真机批(联动 REQ-046「C 上架 → hub 安装」演练场)。

## 明确不做
- 不把资产重新打进 app 包(S22 拍板:内置通道对此三条关闭;A 快照随下次发版 runbook 步自动收录,禁手编);
- 不新增分发基础设施(REQ-032 管线已 prod);
- 不修存量条目缺 per-entry version 的更新角标粒度问题(build 脚本已 warn,23 条存量条目版本随顶层 version 走 —— 属既有行为,另立不在本批)。

## 结果(2026-07-06 回填)

**REQ-045 C 侧全落(alpha-web PR #10,已部署 prod)= shipped**:
- 来源核验:anthropics/skills@`9d2f1ae`,三条 LICENSE.txt 逐条 Apache-2.0 ✓(skill-creator 同源同许可,先例一致);frontmatter name === 目录名 === 条目 name(A 侧防伪名守卫前置自查)✓;
- 资产:mcp-builder 11 文件 119KB(含 scripts/reference)· canvas-design 84 文件 5.4MB(含 OFL 字体)· brand-guidelines 3 文件 14KB;单文件最大 191KB(< A 侧 5MB 帽);catalog.json 60KB(< 2MB 帽);
- prod 复验:`GET /catalog/v1/catalog.json` = 2026-07-06.2、27 entries、ed25519 验签 **VALID**(A 内置公钥);抽样下载(SKILL.md / TTF / NOTICE.md)sha256 **全匹配**;
- REQ-046 纪律首次真实演练成立:上架全程 A 仓零动作,联网用户即时生效。

**verified 门(真机递延)**:A 端「刷新 → 安装 → 账本」链路 → 下一真机批(清单见 BACKLOG REQ-045 行)。
