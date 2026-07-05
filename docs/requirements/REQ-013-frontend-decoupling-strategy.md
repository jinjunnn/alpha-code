---
id: REQ-013
title: 前端脱耦策略 —— 让 alpha UI 免疫上游前端 churn(选定并落地)
type: spike
priority: P1
status: archived
repo: A
created: 2026-07-03
sprint: —
---

## 背景(为什么)

用户诉求(2026-07-03,明确):**「不可能它改一次,我就要跟着改一次。」** 目标 = 上游前端 churn **波及不到** alpha UI,不是"断了有警报"。

根因(已确诊,见 [audits/2026-07-03-frontend-reskin-regression.md](../audits/2026-07-03-frontend-reskin-regression.md)):alpha 前端**深度复用上游渲染树**并用 CSS 挂上游内部 `data-component` 锚点换肤;546-sync 作废 192 锚点中 94 个 → 换肤静默回落。**凡依赖上游 DOM 结构处必跟改;凡只依赖 SDK 数据契约处即免疫。** 本需求 = 选定并落地一个让 UI 依赖从"上游 DOM"迁到"SDK 契约"的策略。

完整方案菜单与取舍见 [designs/2026-07-03-frontend-decoupling-options.md](../designs/2026-07-03-frontend-decoupling-options.md)。

## 方案菜单(按免疫程度)

| 方案 | 做法 | 上游改要跟改吗 | 量 |
|---|---|---|---|
| A 防护网(=REQ-012) | 锚点契约测试+tripwire+冒烟 | 要(静默→红灯) | 小 |
| B 单适配层(=C14++) | alpha 拥有的 inject 层重打稳定 `data-alpha-*` 锚点,CSS 只认 alpha 锚点 | 要,但只改 1 文件 | 中 |
| C 高 churn 区自建 | 时间线消息/工具卡→alpha 自有组件+SDK 取数;重引擎仍复用 | 重灾区不用 | 大 |
| D 全自有渲染层 | 会话/时间线/弹窗全自有,只吃 SDK;上游仅无头引擎 | 基本不用 | 很大 |
| E 冻结上游前端 | sync 排除/钉住 `packages/{app,ui}`,只同步 core/server/sdk | 不用(前端不进 alpha) | 小 **IF 可行** |

## 推荐方案(分层组合,非单选)

> **一句话原则(建议写进 ADR-016 修订)**:**alpha UI 只依赖 `@opencode-ai/sdk` 数据契约,不得依赖上游 DOM 结构;复用上游组件必经 alpha 拥有的稳定 wrapper/适配层,禁止 CSS 直挂上游内部锚点。**

分四步,先便宜止痛、再验一劳永逸的牌、最后按需根治:

1. **立刻止血 —— A 防护网(REQ-012)**:不管终局走哪条,先让下次 sync 的断裂变红灯,不再靠肉眼。
2. **过渡收敛 —— B 单适配层(并入 C14)**:94 处散耦合收敛成 1 处 alpha 拥有的锚点映射;C/D/E 任一都受益。
3. **先验一劳永逸的牌 —— E 可行性 spike**:实测能否把 `packages/{app,ui}` 排除/钉出每日 merge 而不引入 sdk/core 版本偏斜(ADR-016 本就放弃白嫖上游前端升级 → 继续合并其 churn 近乎纯负担)。**这是最该先验的**:若可行 = 最便宜的"永不波及",省下 C/D 大部分重建;若不可行 = 退 B/C/D。
4. **根治(E 不可行或不足时)—— C→D 增量重建**:从时间线工具卡(94 死锚点主集中地)起,逐步把 UI 从上游 DOM 迁到 SDK 契约,增量走向全自有渲染层。

**为什么这样推荐**:A/B 便宜且无悔(任何终局都要);E 是唯一可能"一劳永逸且便宜"的路,但有偏斜风险,故先 spike 验、不 all-in;C/D 是确定免疫但最重,留作 E 证伪后的根治。**纯 A(用户已否)不作答案,仅作安全网。** 100% 免疫不存在——重引擎(终端/diff/流式)受 NON_GOALS#2 必须复用,D 是"除无头引擎外全免疫"。

## 目标(做什么)

1. 出 **E 可行性 spike 结论**(能否安全冻结上游前端);
2. 据结论**拍板终局路径**(E 冻结 / C→D 重建 / 二者混合)并立 **ADR-016 修订或新 ADR**(前端解耦原则);
3. 落地 A(REQ-012)+ B(C14)作为无悔的地基。

## 验收标准(可验证,逐条)

1. **E spike 报告**:实测排除/钉住 `packages/{app,ui}` 于 sync 后,`bun install` + `tsgo` + `bun test` + 桌面启动是否仍绿;若偏斜,记录具体断点与最小可冻结子集。产出 = `docs/audits/` 或本需求验证记录里的明确 verdict。
2. **终局路径拍板**:基于 spike,用户/架构确认走哪条,结论写入本文件 + 立 ADR(与 ADR-016 互链)。
3. **无悔地基就位**:A(REQ-012 防护网)+ B(C14 单适配层)落地,CSS 不再直挂上游内部锚点、只认 alpha 拥有的稳定锚点(改一处即可)。
4. **原则固化**:上述"只依赖 SDK 契约、禁 CSS 直挂上游锚点"写入 rules(ARCHITECTURE / ADR-016 修订),后续前端 PR 受 [[C14]] 审查约束。
5. **回归回放**:用 546-sync 死锚点集验证——所选终局路径下,同类上游改动**不再波及** alpha UI(E 路径=前端不进;C/D 路径=该区已 SDK 化;B 路径=只改 1 映射文件)。

## 非目标

- 不重写上游重引擎(终端/diff/流式 markdown)—— NON_GOALS#2,必须复用(经稳定 wrapper)。
- 不改上游源码修锚点(NON_GOALS#3)。
- 不在本 spike 内一次性重建全部 UI(C/D 是增量路径,按 churn 优先级分批)。
- 本需求是**策略选定 + 无悔地基**;具体 UI 组件重建按选定路径另拆执行需求。

## 方案 / 关联(designs / ADR / 相关 ID)

- 方案菜单:[designs/2026-07-03-frontend-decoupling-options.md]。
- 无悔地基:[[REQ-012]](A 防护网)、[[C14]](B 单适配层/收敛)。
- 症状批:[[REQ-010]]。上位:ADR-016(可能产出修订或新 ADR)。
- 决策入口:BACKLOG ⚖️ 待拍板队列「前端换肤 vs 真组件」→ 收编进本需求。

## 终局拍板(用户 2026-07-03)
**E 冻结 @ 546 前**(= ADR-020,accepted)。⚖️ 队列「前端脱耦终局路径」行已划掉。

## 验证记录
- **E spike(2026-07-03,验收①)**:worktree 实测——`packages/{app,ui}` 干净钉回 `3b638e4a^1`
  (546 前)+ 引擎用当日 HEAD:`bun install` 零变化、typecheck **上游零错**(唯三错误 = alpha 自己的
  WSL probeAddable 适配,冻结世界应回退)、完整 electron-vite build 绿(9.7s)。⟹ 546 commits 偏斜
  仅需 1 处适配,前端↔引擎耦合实证为松,**E 可行**。方法注记:`git checkout ref -- path` 不删新增
  文件,首轮因此出现冻结树内部不一致假象——冻结/re-freeze 必须 `rm -rf` 后 checkout(已写入 ADR-020 §5)。
- **落地(验收②③④,PR #45)**:tag `frontend-freeze-base`;app/ui 还原冻结基 + WSL 适配回退;
  `sync-upstream.yml` restore 步(含上游新增文件清除)+ app/ui 冲突预期化;`alpha-ci.yml` 守卫范围
  修订;ADR-020 + ARCHITECTURE/NON_GOALS 修订;A 防护网已先行(REQ-012,PR #44);B 适配层在冻结下
  降级为 re-freeze 工具(见 C14 行)。
- **回归回放(验收⑤)**:E 路径下 546 类上游改动不再进入 alpha(sync 只进引擎)——同类断裂物理不可能;
  防护网保留作 re-freeze 体检。
- **待(verified 门槛)**:冻结态真机视觉核验(→ S9 真机批,兼 REQ-010 验收)+ 首次每日 sync 的
  restore 步实跑观察。
