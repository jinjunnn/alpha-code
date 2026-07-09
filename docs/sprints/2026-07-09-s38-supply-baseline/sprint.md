# S38 — 供给面基线批:内置技能补全 + 办公三连上架 + hub curation(2026-07-09)

> 契约(ADR-018):目标 / 抽取 IDs / task 表 / gates / 结果 / 回写清单。

## 目标

把「开箱供给面」补齐到拍板基线:云派发与办公文档两件出厂技能(7 件基线成形)、办公 MCP 三连上架(C 侧)、定制中心浏览面回归「可安装的精选」(撤引擎原生 agent 平铺)。

## 抽取

| ID | 仓 | 状态入 | 状态出 |
|---|---|---|---|
| REQ-082 | A | ready | shipped(PR #170;残单 = 登录态真派发一单) |
| REQ-080 | X(A+C) | ready | shipped(A=PR #170,C=alpha-web PR #17 已部署实证;残单 = hub 装 + xlsx 真调用) |
| REQ-079 | X(A+C) | ready | shipped(PR #171,UI 亲验门待 GO;C 侧精选增补随 REQ-080 落地) |

## Tasks

- [x] T1(REQ-082)出厂技能 `cloud-dispatch`:SKILL.md(工具面/信封契约/预算档位/数据边界/前置如实声明,全部按 B 侧 cloud-mcp.ts + cloud-contract.ts 实况写)+ factory-skills.ts 登记 + seed 守卫 + 测试(PR #170)
- [x] T2(REQ-082)customize-alpha 扩「连接器/套件」章节(hub 主路径 + `alpha_register type=mcp` 次路径 + 密钥 `{file:}`/receipts 诚实边界 + uvx/npx runtimeDep);出厂技能 7 件基线写入 GLOSSARY(PR #170)
- [x] T3(REQ-080 A)出厂技能 `office-docs`:连接器选型 + xlsx 惯例(自写重表达,零 Anthropic 文本)+ PDF 缺口 pypdf/reportlab 引导 + 登记/守卫/测试(PR #170)
- [x] T4(REQ-080 C)alpha-web catalog 增 3 条 mcp(钉版 + runtimeDep=uv + word→PDF 如实标注;**启动命令逐包实证**:excel 需 `stdio` 子命令、word/ppt 经 `--from` + entry point)+ bundle:office 五件收口 + v2026-07-09.2 → build-catalog 签名 → alpha-web PR #17 → ECS 部署 → 线上实证(27 条/签名 verify=true)+ 三连 stdio 握手冒烟 3/3
- [x] T5(REQ-079)Agent tab 浏览/搜索面撤原生平铺(`!native`)+ callout 指路治理面板 + 自建回退文案纠正(PR #171,UI 亲验门待 GO);精选提案 = curation-proposal.md(保留两条 catalog agent、不删不补、出厂件不重复上架)
- [ ] T6 单测 + alpha-check 全绿;CDP 截图核验(Agent tab 前后 + 技能就位)

## Gates

- [x] alpha-check(北极星守卫 + typecheck + 单测)全绿(两 PR 各自过 CI 四关)
- [x] 零改上游文件
- [x] office-docs 技能 license 审查:全文 alpha 自写(惯例重表达;代码片段仅引用 BSD 库 reportlab/pypdf,零 Anthropic 技能文本)
- [x] cloud-dispatch 技能文案与 B 侧 schema 零矛盾(cloud-mcp.ts 八工具名 / envelope 字段 / 预算默认与帽 / schedule 限制与熔断 3 逐项对照源码)

## 精选清单提案(REQ-079 残点,交拍板)

见本目录 `curation-proposal.md`(开工提案,不阻塞本批实现)。

## 回写清单

- [ ] BACKLOG REQ-082/080/079 → shipped(PR 号)
- [ ] CHANGELOG [Unreleased] 用户可见条目
- [ ] 三份需求档 frontmatter 同步
- [ ] 证据:audits/2026-07-09-s38-supply-baseline/
