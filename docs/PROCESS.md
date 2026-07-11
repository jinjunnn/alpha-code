# 历史开发流程手册(需求 → sprint → 发布 → 归档)

> [!IMPORTANT]
> **历史流程,已于 2026-07-11 停用。** GitHub Issues 与
> [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 现在是活跃需求、
> 状态、优先级、负责人和 Sprint 的唯一真源。不要执行下文“读 BACKLOG 抽取、
> 新建本地 sprint、翻 Markdown 状态”的步骤。当前规则见
> [alpha-work delivery standard](https://github.com/jinjunnn/alpha-work/blob/main/governance/delivery-standard.md)。
> 本文正文仅为迁移前历史证据。

> 权威决策:[ADR-018](../.claude/rules/adrs/ADR-018-req-lifecycle.md)。本文 = 操作手册 + 模板。
> 真源:`docs/BACKLOG.md`(工作项状态)· `docs/CHANGELOG.md`(用户可见变更)。**状态只在 BACKLOG 翻转,其余文档一律 append-only 证据。**

## 0. 一图流

```
登记 ──► 定级 ──► (分析) ──► ready ──► 抽取进 sprint ──► build ──► review/test ──► ship ──► verify ──► 同步 ──► 归档
BACKLOG   P0-P3    REQ 文件            sprints/<date>/   /app:build  /app:review    PR 合入   真机实测   PR 回写   retro 批量
加一行    +类型+仓  (仅全流程)          sprint.md                     +qa(需要时)              截图/测试   3 件套
```

状态机:`registered → ready → in-sprint → shipped → verified → archived`;旁路 `parked / rejected / dup`。

## 1. 目录契约(docs/ 谁干什么)

| 路径 | 角色 | 纪律 |
|---|---|---|
| `BACKLOG.md` | 工作项单一真源 | 状态**只**在此翻转 |
| `CHANGELOG.md` | 用户可见变更(按发布版本) | 随实现 PR 写 [Unreleased] |
| `PROCESS.md` | 本手册 | — |
| `requirements/` | 需要分析的需求 `REQ-NNN-<slug>.md` | 快车道小项不建文件 |
| `sprints/YYYY-MM-DD-<slug>/` | 执行批次,`sprint.md` 必有 | **唯一「计划」落点** |
| `designs/` | 设计方案(`/app:design-*` 产物) | append-only,不承载状态 |
| `audits/` | 审计证据 | append-only;发现必须登记 BACKLOG 才算数 |
| `retros/` | 回顾(`/app:retro` 产物) | append-only |
| `qa/` | 测试计划 / 运行(`/app:test-plan` `/app:qa`) | — |
| `debates/` | 质疑记录(`/app:challenge` 产物) | — |
| `archive/YYYY-MM/` | 过时文档归档 | 移入保留原文件名 |
| `plans/` | ❄️ **冻结(legacy)** | 不再新增;现存登记册为审计证据 + 叙事历史 |
| 顶层散文件 | 长期参考(UNDERSTANDING / DISTRIBUTION / platform-* / architecture/ / diagrams/) | 新增前自问:是否该进上面某目录 |

## 2. 登记(intake + triage)

**来源四类** → 全部先在 BACKLOG Active 加一行:
1. **审计发现**:审计报告落 `audits/`,发现按其原 ID(A/B/C/D…)入册,行内链证据,不复制长文;
2. **用户需求**:分配 `REQ-NNN`(单调递增,永不复用);
3. **retro 行动项**:同 REQ 系列;
4. **upstream sync 波及**(契约 diff 适配、行为矛盾):REQ 系列或并入既有条目。

**上游归属先标**(register R2 纪律):问题根在 `packages/{opencode,core,server,…}` 的,登记 **alpha 侧杠杆**(env / 接缝 / 配置 / 「接受」),绝不排「改上游」任务(NON_GOALS#3)。

**定级**(沿用登记册 §一定义):
- **P0** 安全泄漏 / 数据丢失 / 分发硬阻断 / 核心路径崩溃 —— 插队,下一 sprint 必含;
- **P1** 分发后必踩 / 愿景关键链路断点 —— 排期主体;
- **P2** 债务(安全面 / 健壮 / 治理)—— 按域顺带;
- **P3** 卫生 —— 同文件顺手时做。

**类型**:`feature / bug / debt / security / perf / ux / docs / spike`(spike = 调研,产出 = 报告或 ADR)。
**仓**:`A`(alpha-code)/ `B`(alpha-platform)/ `C`(alpha-web)/ `X`(跨仓)。

## 3. ready 门槛(两档)

- **快车道**(bug / debt / 卫生,验收自明):登记行即 `ready`,**验收标准必须存在**——写在行内,或建 `requirements/<ID>-<slug>.md` 小档(2026-07-03 用户要求下,审计存量 A/B/C/D 开放项已全量建档;新小项两种形式任选,但不允许无验收标准的行)。
- **全流程**(feature / spike / 架构变更):建 `requirements/REQ-NNN-<slug>.md`(模板 §8),**必含可验证的验收标准**;大项先 `/app:challenge` 质疑;要设计的走 `/app:design-*`(产物进 `designs/`,REQ 文件链接之);出现架构决策 → 立 ADR 并与 REQ 互链。

## 4. Sprint(抽取与执行)

**抽取规则**:P0 全部 > 发布短名单(BACKLOG 顶部)> P1 按域聚类(同子系统 / 同文件的一起做,减上下文切换)> P2 顺带。**WIP = 1**:上一 sprint 未收尾(§5 回写完)不开新的。

**开工协议(每次 session 的标准起手,2026-07-03 与用户确认)**:用户说「按 BACKLOG 开工 / 开 sprint」→
1. 读 `BACKLOG.md`,过滤**可抽取**项:`status = ready` **且前置已清**(备注中「前置=X」「受 A6 门控(R3)」等未清视为 blocked,自动跳过)**且非 parked**;
2. 按抽取规则拟 **sprint 提案**(目标、条目清单、预计规模),连同各条的验收标准来源(requirements 文件)一起给出,**并附 BACKLOG「⚖️ 待拍板队列」提醒**(需用户方案决策的点——它们不是 blocked,可进 sprint,但未拍板的决策点不得代替用户决定);
3. **等用户批准提案后**才建 sprint 目录、翻 in-sprint、动代码(用户明说「直接开工不用问」可跳过本 gate);
4. 执行中遇到**需单独批准类必停**:① 产品/定位决策(spike 拍板项,如 REQ-008、REQ-006 未决项)② 不可逆动作(数据迁移、删用户数据、发布、改 appId/渠道)③ 用户可见默认行为翻转。其余技术实现不逐项请示——**需求文件的验收标准即契约**。

**开 sprint**:建 `sprints/YYYY-MM-DD-<slug>/sprint.md`(模板 §8)——写目标、抽取的 IDs(BACKLOG 同步翻 `in-sprint`)、拆 task(T 表 + checkbox)。

**PR 粒度(sprint ≠ PR,2026-07-03 与用户确认)**:sprint 是**计划/执行批次**,PR 是**合入单位**——一个 sprint 通常产出**多个短命 PR**,每个 PR = 1 个需求或一个同域小簇(diff 可审、可独立回退,如 A2a 单文件即单独成审)。**禁止长命 sprint 大分支**(每日 upstream sync 合入 alpha 会使其持续漂移,违背 ADR-005 短命分支纪律);微型 sprint(单一小域)可只有 1 个 PR。sprint.md 的 task 表记录每项落在哪个 PR(§5 三件套随**每个** PR 即时回写,不等 sprint 收尾)。

**模型分层(2026-07-03 与用户确认)**:开工提案时在 sprint.md task 表的「模型」列按 **风险 × 模糊度** 给每个 task 定档(难度是输入之一,非唯一维度);执行时按档**委托子代理**,主会话保持最强模型做编排 / 审查 / 收口:
- **fable(最强)**:安全类(A6/C24/C25/C27…)、架构与跨仓设计、上游耦合面改动(C14 类)、不可逆动作、模糊需求的方案设计;
- **opus(中坚)**:验收标准明确的常规 feature / bug 实现(B 系列大部分)、性能修复、联调执行;
- **sonnet(机械)**:i18n 补全、文档 / 状态回写、测试脚手架、D 系列卫生、批量机械改动。

硬规则:① 安全 / 北极星耦合 / 不可逆 → 一律 fable,**不下放**;② **审查与验收所用模型 ≥ 实现所用模型**(便宜模型写、强模型审;反向禁止);③ 拿不准不标,继承会话默认;④ [[visual-verify-required]] 与模型档位无关,一律执行。

**执行**(对应 `/app:*` 命令):`/app:build`(实现)→ `/app:review`(审查)→ `/app:qa`(需要时)→ `/app:ship`(PR)。全自动串联可用 `/app:sprint`。

**硬 gates(每个实现 PR)**:typecheck + `bun test` + alpha-ci 北极星守卫绿 + §5 回写三件套。

## 5. 同步纪律(防「做了但看着没跟踪」)

**实现 PR 必须同时包含**:
1. BACKLOG 对应行状态 → `shipped`(+ PR 号);
2. sprint.md task 勾选;
3. 用户可见变化 → CHANGELOG `[Unreleased]` 一条(内部债务不写 changelog,只翻 BACKLOG);
4. **有需求档者**:同步翻该 `requirements/<ID>-*.md` 的 frontmatter `status` 与 BACKLOG 一致(→ `shipped`;verify 时 → `verified`)。快车道无档小项跳过。**BACKLOG 仍是唯一真值**——本条只防「打开档案看到 `ready`、实际已 shipped」的误导(2026-07-03 用户拍板补入,ADR-018 §决策6 ④)。

**verify**(shipped → verified):按验收标准**真机 / 截图 / 测试**复验([[visual-verify-required]] 纪律);verify 通过时**一并翻需求档 frontmatter → `verified`**(§5.4);打版发布时 `[Unreleased]` → `[x.y.z]`。
跨会话要记住的非代码事实 → memory;架构决策 → ADR。

## 6. 归档

`/app:retro` 时:
- `verified` 行 → BACKLOG Done 分节;Done 过长(> 一季度)移 `archive/backlog-done-YYYYQn.md`;
- 过时叙事文档:标 superseded 头(被引用的留原地)或 `git mv` 进 `archive/YYYY-MM/`(无引用的);
- 需求文件**不物理移动**(保 `[[REQ-NNN]]` 引用稳定;2026-07-03 用户确认**不迁归档目录**),retro 时 frontmatter `status` 翻 `archived`(shipped/verified 的 frontmatter 已随实现 PR 翻,见 §5.4,此处只做终态 archived);
- rules / GOALS / GLOSSARY 反哺照旧(retro 既有职责)。

## 7. 跨仓(A / B / C)

- BACKLOG 是**产品级**:三仓交付物都登记(`仓` 列);B / C 内部实现细节留各自仓的 rules / docs。
- 引用规范(ADR-018 §8,钉死 C7):跨仓 ADR 写 `B/ADR-xxx` / `PA-N`(platform)/ `WA-N`(web);本仓编号只管本仓。
- alpha-platform(`~/app/alpha-platform`)侧:**用户已授权直接管理**(2026-07-03)——B 侧改动在其仓内做,交付物状态回写本 BACKLOG。

## 8. 模板

### BACKLOG 行
```
| REQ-005 | 一句话标题 | feature | A | registered | 来源/证据链接;前置;备注 |
```

### 需求文件 `requirements/REQ-NNN-<slug>.md`
```markdown
---
id: REQ-NNN
title: 一句话标题
type: feature | bug | debt | security | perf | ux | docs | spike
priority: P0 | P1 | P2 | P3
status: registered | ready | in-sprint | shipped | verified | archived | parked
repo: A | B | C | X
created: YYYY-MM-DD
sprint: —
---

## 背景(为什么)
## 目标(做什么)
## 验收标准(可验证,逐条)
## 非目标
## 方案 / 关联(designs / ADR / 相关 ID)
## 验证记录(verify 时补:日期 + 方式 + 结果)
```

### `sprints/YYYY-MM-DD-<slug>/sprint.md`
```markdown
# Sprint YYYY-MM-DD <slug>

**目标**:一句话。
**抽取**:REQ-xxx、A6、…(BACKLOG 已翻 in-sprint)

| Task | 内容 | 对应 ID | 模型 | 状态 |
|---|---|---|---|---|
| T1 | … | A6 | fable | ☐ |

**Gates**:typecheck ☐ · bun test ☐ · 北极星守卫 ☐ · /app:review ☐ · /app:qa(需要时)☐
**回写**:BACKLOG ☐ · CHANGELOG ☐ · verify 记录 ☐ · retro 链接:…
```

## 增量交付的回写边界(2026-07-04 补,S13 实践)

单个 REQ 拆多个实现 PR 时:**sprint.md 任务勾选随各实现 PR**;BACKLOG 状态、需求档 frontmatter、CHANGELOG 在**批次末尾 PR 统一翻转**(需在 sprint.md 的 PR 粒度声明中写明)。ADR-018 §6「每个实现 PR 回写」的单位按此解释为「每批次」,防中间态频繁翻表。
