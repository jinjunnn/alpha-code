---
id: REQ-012
title: 上游同步前端回归防护:锚点契约测试 + sync tripwire + post-sync 视觉冒烟 gate
type: debt
priority: P1
status: verified
repo: A
created: 2026-07-03
sprint: —
---

## 背景(为什么)

见审计 [audits/2026-07-03-frontend-reskin-regression.md](../audits/2026-07-03-frontend-reskin-regression.md)。**已确诊**:546-sync 静默作废 reskin 依赖的上游 DOM 锚点 **192 中 94(49%)**,换肤回落上游默认,全部 gate 绿放行,v0.1.0 前端零复验发布。用户反馈「已经回归非常多次了」——因为 `sync-upstream.yml` **每日**合并,而**没有任何 gate 能拦住语义级换肤断裂**:

- 北极星守卫(ADR-004)只查 file-diff(有没有编辑上游),零冲突合并=绿;
- typecheck/test 不覆盖 CSS 选择器;
- 唯一语义 tripwire(ADR-015,`sync-upstream.yml:61-80`)只管 prompt/agent,**前端无等价物**;
- C14(薄 re-export 收敛层)未启动,锚点分散不集中、断了不报警。

ADR-015 已为 prompt 层证明了正确范式(file-diff 测不出的语义漂移 → 合并验证 gate + tripwire);本需求 = **把该范式扩到前端 reskin**,让「静默回归」变「合入/发布前高声失败」。

## 目标(做什么)

建立前端 reskin 的升级回归防护网,使任何上游 sync 删/改 reskin 依赖的锚点在**合入 alpha / 打包发布前**被机械拦截,不再靠用户肉眼发现。

## 验收标准(可验证,逐条)

1. **锚点契约清单**:reskin 依赖的上游 `data-component`/`data-action`/`data-slot` 锚点收敛为单一机器可读清单(与 C14 薄 re-export 层同源;可从现有 CSS 抽取种子清单,当前 192 项)。
2. **锚点存在性测试(基石)**:一个 `bun test` 断言清单中每个锚点在上游源码/构建产物中仍存在;**故意删一个锚点该测试必红**(用例证明)。
3. **前端 sync tripwire**:`sync-upstream.yml` 增一步——当本次 sync 触碰 `packages/{app,ui}` 中承载锚点的组件(或锚点测试失败)时,`::warning` + PR label + job summary 要求人工视觉复验(镜像现有 prompt tripwire 结构)。
4. **post-sync 视觉冒烟纳入升级 runbook**:`DISTRIBUTION.md`/升级 runbook 增「合并后、发布前」CDP 截图关键屏(首页/会话/模型卡/composer/时间线)对基线的**必做清单项**(比照 ADR-017 重打包 verify 清单);retro 模板补前端复验行。
5. **闭环验证**:用本轮 546-sync 的死锚点集回放——防护网若当时在位,能否红灯拦下(离线复算即可)。

## 非目标

- 不改上游源码修锚点(NON_GOALS#3);锚点变了就更新我方清单/换肤,不动上游。
- 不在本需求内修 REQ-010 的具体视觉症状(那是症状批;本需求是**防复发机制**)。
- 不做全量像素级视觉回归 diff 基建(YAGNI;先锚点契约 + 关键屏人工/半自动冒烟,失控再上像素 diff)。

## 方案 / 关联(designs / ADR / 相关 ID)

- 证据:[audits/2026-07-03-frontend-reskin-regression.md]。
- 结构治理另一半:[[C14]](薄 re-export 收敛层,ADR-016 待办①)——清单(验收1)即其载体,合并推进。
- 范式来源:ADR-015 合并验证 + `sync-upstream.yml` prompt tripwire;建议产出 **ADR-016 修订**(或新 ADR)把「前端合并验证 gate」正式化。
- 症状批:[[REQ-010]];收尾核验:[[REQ-005]]。

## 决策记录(范围,用户 2026-07-03 拍板)
**锚点存在性契约测试 only,不做像素级视觉回归基线**(YAGNI;关键屏冒烟走 runbook 人工/CDP)。⚖️ 队列该行已划掉。

## 验证记录
- **2026-07-03(PR #44)**:交付四件——①清单 `upstream-anchors.json`(alive 195 / knownDead 4,
  gen 脚本再生;= C14 收敛层载体)②契约测试 5 用例全绿(新鲜度/alive 红线/knownDead 双向诚实/
  故意断言必红/选择器形态防骗)③ `sync-upstream.yml` 前端 tripwire(镜像 ADR-015)④ DISTRIBUTION.md
  发版步骤 ⓪ 前端合并复验。
- **验收⑤回放**:防护网首跑即修正原审计量化(94 死 → 真死 4,余为 session-ui 搬包;v0.1.0 回放 0 名字级死
  → 结构性断裂假说上位)——证明它能捕捉「搬家/复活/死亡」全部三态;详见审计修正节。
