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
- [ ] REQ-065 skills.paths 直指 Resources + reconcile 拆存量出厂链
- [ ] REQ-062 T1 transform 转写 · T2 identity · T3 init/review · T4 customize-alpha · T5 lsp(可后置)· T6 general/explore
- [ ] REQ-063 default-deny flags · 项目信任门 · 导入转换 · 全局迁移门(发布闸)

## 结果

(随 PR 回填)
