---
id: ADR-018
title: 需求生命周期与文档流:单一真源 BACKLOG + 两档流程 + Sprint 契约 + 归档纪律
status: superseded
date: 2026-07-03
superseded_by: jinjunnn/alpha-work/governance/ADR-001-github-delivery-sot.md
related: [ADR-004, ADR-005, ADR-014, ADR-015]
---

> **Superseded 2026-07-11.** 本 ADR 保留为迁移前流程历史。活跃需求、
> Issue 状态、优先级和 Sprint 已迁至 GitHub Issues 与 Alpha Delivery;当前规则见
> `jinjunnn/alpha-work/governance/delivery-standard.md`。以下 BACKLOG 和本地
> Sprint 决策不得用于新工作。

## 背景
截至 2026-07-03,工作项状态散在多处、互不同步:71 项审计登记册(迁移前 plans 登记册,已退役至 `docs/archive/DEPRECATED.md`)是 append-only 叙事,进度记在 §7f–§7j 八批日志(PR #22–#33)里,**没有按 ID 的状态矩阵** → 「记了但看着像没跟踪」;E 系列(迁移前 harness-extension-backlog,已退役至 `docs/archive/DEPRECATED.md`)、S/T 系列(sprint/task)、G 系列(GOALS)各自为政;docs/ 顶层真源/证据/历史混杂;需求「登记→分析→排期→开发→测试→同步→归档→changelog」没有标准流程,新需求(如本日 REQ-001~004)无固定落点。

## 决策
1. **单一真源 = `docs/BACKLOG.md`(迁移前;已退役,见 `docs/archive/DEPRECATED.md`)**。所有工作项(审计发现 / 用户需求 / retro 行动项 / upstream-sync 波及 / 跨仓交付物)必须先在此登记一行才可进 sprint;**状态只在 BACKLOG 翻转**。审计 / 设计 / retro / 叙事文档一律 append-only 证据,不承载状态。
2. **ID 纪律**:既有系列保留原号(A/B/C/D 审计、E harness、T task、G 目标),新需求一律 `REQ-NNN` 单调递增;ID 永不重编 / 复用;重复项标 `dup → X` 不删行。
3. **状态机**:`registered → ready → in-sprint → shipped → verified → archived`;旁路 `parked / rejected / dup`。shipped = PR 合入;**verified = 按验收标准实测通过**(真机 / 截图 / 测试,见 [[visual-verify-required]])——两态不可合并,本仓多次踩「合了没验」。
4. **两档流程**:**快车道**(bug / debt / 卫生,验收自明)= 登记行即 ready,证据链到审计文档;**全流程**(feature / spike / 架构)= 建 `docs/requirements/REQ-NNN-<slug>.md`(背景 / 验收标准 / 非目标),大项先过 `/app:challenge`,需设计走 `/app:design-*`;出现架构决策照旧立 ADR 并互链。
5. **Sprint 契约**:执行批次 = `docs/sprints/YYYY-MM-DD-<slug>/sprint.md`(目标 / 抽取 IDs / task 表 / gates / 结果 / 回写清单)。**抽取规则**:P0 全清 > 发布短名单 > P1 按域聚类 > P2 顺带;**WIP=1**(上一 sprint 未收尾不开新的);上游归属条目只排 alpha 侧杠杆(register R2,NON_GOALS#3)。
6. **完成同步纪律(反「看着没跟踪」)**:实现 PR 必须同时包含 ① BACKLOG 状态翻 shipped(+PR 号)② sprint.md task 勾选 ③ 用户可见变化写 `CHANGELOG.md` [Unreleased] ④ **有需求档者翻其 frontmatter `status` 与 BACKLOG 一致**(2026-07-03 用户拍板补入;防档案 status 滞后误导——BACKLOG 仍**唯一真值**,本条只消除「档案 ready、实已 shipped」的观感,快车道无档小项免)。verified 由实测翻(需求档 frontmatter 一并翻 verified);retro 时批量 verified→archived 移入 Done 归档。
7. **目录契约与归档**:真源三件(`BACKLOG/CHANGELOG/PROCESS`)+ `requirements/ sprints/ designs/ audits/ retros/ qa/ debates/ archive/`;顶层散文件仅长期参考。**`docs/plans/` 冻结**——计划 = sprint.md,方案 = designs/,不再新增 plans;过时文档标 superseded 头或移 `docs/archive/YYYY-MM/`。**需求档永不物理移动**(2026-07-03 用户确认):归档只把 frontmatter `status` 翻 `archived`、留原路径,保 `[[REQ-NNN]]` 引用稳定;**不设 `requirements/archived/` 子目录**(迁移会断全部引用链接,得不偿失)。
8. **跨仓**:BACKLOG 是**产品级**真源(A=alpha-code / B=alpha-platform / C=alpha-web 的交付物都登记,`仓` 列标注);B/C 内部实现细节留各仓。跨仓 ADR 引用规范(顺带钉死 C7):`B/ADR-xxx`、`PA-N`(platform)、`WA-N`(web);本仓编号只管本仓。

操作手册与模板:`docs/PROCESS.md`(迁移前流程,已退役,见 `docs/archive/DEPRECATED.md`)。

## 后果
- ✅ 任意会话可从 BACKLOG 直接抽 ready 项开 sprint(兑现「每次执行直接抽取待开发任务」);按 ID 的完成 / 未完成矩阵永远现成,不再需要事后拉平。
- ✅ 71 项审计 + E 系列 + REQ-001~004 已于 2026-07-03 一次性收敛入册;docs/ 每目录角色单一。
- ⚠️ 每个实现 PR 多一次表格回写(~1 分钟)——这是防叙事漂移的最低成本;漏回写由 `/app:review` 的完成定义检查兜底。
- ⚠️ BACKLOG 是手维护 markdown,无 schema 守卫;先靠 PROCESS.md 行格式纪律,失控再上脚本校验(YAGNI)。
- 🔭 待办:`/app:sprint` 等命令产物路径与本 ADR 已天然兼容(sprints/designs/qa/retros 不变),后续 retro 时核对一次即可。
