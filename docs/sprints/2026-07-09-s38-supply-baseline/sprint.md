# S38 — 供给面基线批:内置技能补全 + 办公三连上架 + hub curation(2026-07-09)

> 契约(ADR-018):目标 / 抽取 IDs / task 表 / gates / 结果 / 回写清单。

## 目标

把「开箱供给面」补齐到拍板基线:云派发与办公文档两件出厂技能(7 件基线成形)、办公 MCP 三连上架(C 侧)、定制中心浏览面回归「可安装的精选」(撤引擎原生 agent 平铺)。

## 抽取

| ID | 仓 | 状态入 | 状态出 |
|---|---|---|---|
| REQ-082 | A | ready | — |
| REQ-080 | X(A+C) | ready | — |
| REQ-079 | X(A+C) | ready | — |

## Tasks

- [ ] T1(REQ-082)出厂技能 `cloud-dispatch`:SKILL.md(工具面/信封契约/预算档位/数据边界/前置如实声明,全部按 B 侧 cloud-mcp.ts + cloud-contract.ts 实况写)+ factory-skills.ts 登记 + seed 守卫 + 测试
- [ ] T2(REQ-082)customize-alpha 扩「连接器/套件」章节(hub 主路径 + `alpha_register type=mcp` 次路径 + 密钥 `{file:}`/receipts 诚实边界 + uvx/npx runtimeDep);出厂技能 7 件基线写入 GLOSSARY
- [ ] T3(REQ-080 A)出厂技能 `office-docs`:连接器选型 + xlsx 惯例(自写重表达,零 Anthropic 文本)+ PDF 缺口 pypdf/reportlab 引导 + 登记/守卫/测试
- [ ] T4(REQ-080 C)alpha-web catalog 增 3 条 mcp(excel-mcp-server / office-word-mcp-server / office-powerpoint-mcp-server,钉版 + runtimeDep=uv + word→PDF 需本机 Word 如实标注)+ bundle:office 补齐 + version bump → build-catalog → PR → 部署 → 线上验证
- [ ] T5(REQ-079)Agent tab 浏览面撤引擎原生 agent 平铺(搜索面同口径;治理面板管理入口不动);精选清单提案(删减/补充)写本档「提案」节交拍板
- [ ] T6 单测 + alpha-check 全绿;CDP 截图核验(Agent tab 前后 + 技能就位)

## Gates

- [ ] alpha-check(北极星守卫 + typecheck + 单测)全绿
- [ ] 零改上游文件
- [ ] office-docs 技能 license 审查:零 Anthropic 技能文本抄袭(仅 BSD/MIT 底层库引用)
- [ ] cloud-dispatch 技能文案与 B 侧 schema 零矛盾(工具名/字段/预算帽逐项对照)

## 精选清单提案(REQ-079 残点,交拍板)

见本目录 `curation-proposal.md`(开工提案,不阻塞本批实现)。

## 回写清单

- [ ] BACKLOG REQ-082/080/079 → shipped(PR 号)
- [ ] CHANGELOG [Unreleased] 用户可见条目
- [ ] 三份需求档 frontmatter 同步
- [ ] 证据:audits/2026-07-09-s38-supply-baseline/
