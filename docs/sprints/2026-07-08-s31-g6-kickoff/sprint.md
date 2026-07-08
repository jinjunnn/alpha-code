# Sprint S31 — G6 去 opencode 化开工批(2026-07-08)

> 目标线:GOALS G6(权威决策 = ADR-015 2026-07-08 修订 + ADR-024 + ADR-019 2026-07-08 修订)。
> 用户拍板顺序:REQ-066(最小,天天看得见)→ REQ-065(目录心智)→ REQ-062/063(主体);
> REQ-061 快车道(与 REQ-066 同文件 alpha-composer.tsx,顺带同批)。

## 抽取 IDs(全 ready,BACKLOG 2026-07-08)

| ID | 类型 | 摘要 | 状态 |
|----|------|------|------|
| REQ-066 | ux | 斜杠菜单卫生:治理禁用项不显示 + 命令来源标注 + agent 选择器守卫 | in-sprint |
| REQ-061 | bug | composer 弹层 click-outside 竞态(composedPath 修) | in-sprint |
| REQ-065 | debt | `.alpha` 纯度反向收口:出厂件退出 `~/.alpha/skills` | in-sprint |
| REQ-062 | feature | 路线A 品牌转写(transform hook + identity + init/review + customize-alpha + general/explore) | in-sprint |
| REQ-063 | security | 外部生态继承 default-deny + consent 导入门 | in-sprint |

## Gates

- 每项独立 PR(短命 feat/* 分支,merge 后即删,ADR-005 修订);
- push 前 `bash scripts/alpha-check.sh` 全绿(北极星守卫 + typecheck + 单测);
- 零改上游文件(REQ-062 转写为运行时内存转写,磁盘一字节不动);
- 逃生开关逐项可关:`ALPHA_PROMPT_REBRAND_DISABLE` / `ALPHA_ECOSYSTEM_INHERIT`;
- UI 变更走 [[visual-verify-required]](真机截图归下一真机批,PR 内先组件级测试)。

## 回写清单(每 PR)

- [ ] BACKLOG 状态翻 shipped(+PR 号)
- [ ] 本 sprint.md task 勾选
- [ ] docs/CHANGELOG.md [Unreleased]
- [ ] 需求档 frontmatter status 同步

## Task 表

- [x] REQ-066 T1 治理禁用项过滤(govRead skills.deny,免重启)(PR #149)
- [x] REQ-066 T2 来源标注(内置/技能/项目/MCP/导入)(PR #149)
- [x] REQ-066 T3 agent 选择器治理守卫测试(PR #149)
- [x] REQ-061 useChip.onDoc composedPath 判定 + 红绿单测(PR #150)
- [x] REQ-065 skills.paths 直指 Resources + reconcile 拆存量出厂链(PR #151)
- [x] REQ-062 T1 transform 转写 · T2 identity · T3 init+review(review 初版漏接管,用户当日纠正补上)· T4 customize-alpha · T6 general/explore(PR #152 + review 补丁 PR;T5 lsp 按档后置)
- [x] REQ-063 default-deny flags · 项目导入门 · 导入转换 · 全局迁移门(发布闸)· integrate-project skill(PR #153)

## 结果

全部 5 项 shipped(单日,2026-07-08):
- REQ-066 → PR #149(菜单治理过滤 + 来源标注;真机截图归下一真机批)
- REQ-061 → PR #150(composedPath 修;真机走查归 B21 既有承诺批)
- REQ-065 → PR #151(.alpha 零出厂件;存量拆链留痕真机批验)
- REQ-062 → PR #152(转写 13 子串 + init/general/explore 内容接管 + customize-alpha;**ext 测试进两道门 = drift 锁机械化**;T5 lsp 后置;review 刻意不覆盖已档案注记)
- REQ-063 → PR #153(default-deny + 项目/全局导入门 + integrate-project;**发布闸 = T4 迁移门已实现,真机批必须含 ~/.claude/skills 非空首启用例**)

**真机批(2026-07-08 当日执行,证据 [audits/2026-07-08-g6-realmachine-batch](../../audits/2026-07-08-g6-realmachine-batch/verify.md))**:
- **REQ-062/065/066 → verified → archived(用户拍板)**:双模型自称 alpha-code 零 opencode / 存量出厂链拆除 + `.alpha` 全树可溯 / 菜单过滤 + 来源徽标 + 免重启;残项(REQ-062 ②③④⑧、REQ-066 ②)随下批;
- **REQ-067(场中新增,用户拍板)→ verified → archived**:出厂路径与出厂禁**双双零明文**(PR #155/#156)——`alpha.jsonc` 只剩用户内容,出厂件全部内存注入;
- **REQ-063 保持 shipped**:deny 生效(graphify 不可见)+ 全局迁移门弹出记账已验;**卡点 = 项目门弹窗与导入转换需人工点击**(原生弹窗自动化点不了);
- **REQ-061 保持 shipped**:自动化未构造出原复现场景(点「添加供应商」未进 step1),归下批人工走查。
