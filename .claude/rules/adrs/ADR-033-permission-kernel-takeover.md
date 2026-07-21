---
id: ADR-033
title: Permission 内核接管:REQ-090 #433 的 permission 引擎/契约面走 L3 冻结接管
status: accepted
date: 2026-07-21
related: [ADR-004, ADR-020, ADR-029, REQ-090]
issue: https://github.com/jinjunnn/alpha-code/issues/456
---

> **状态:accepted(owner 2026-07-21 拍板「批准接管」,#456 单向门决策)。** 本 ADR 把
> REQ-090 #433 已实现、但以 ADR-029 明禁的 **L4 形态**执行的 permission 引擎收编,正式登记为
> **L3 冻结接管**——给既成事实一个合法身份,不重做、不推翻 #433。逐文件依据见只读审计
> [`docs/audits/2026-07-21-north-star-guard-upstream-delta.md`](../../../docs/audits/2026-07-21-north-star-guard-upstream-delta.md)。

## 背景

1. **REQ-090 产品所有权**要求 alpha 拥有 permission 确认/授权表面。[#433](https://github.com/jinjunnn/alpha-code/issues/433)/PR [#437](https://github.com/jinjunnn/alpha-code/pull/437)(squash `fd357d58`,2026-07-20)实现了 permission 引擎收编:admission 冻结快照、sha256 fingerprint、DecisionReceipt、幂等 reply、409、DB 持久化——实现 AC3/AC8。
2. **但它以 L4 执行**:直接编辑仍在同步的上游文件(`packages/{core,server,opencode,sdk}` 内 21 个),而 [[ADR-029]] 铁律规定 **L4(直接编辑同步中的文件)永不设立**。因此 north-star guard(零上游编辑)对这 21 个文件长期报红,一直被 `--admin` 盖着,直到 PR #455 的 path-filter 暴露(见 [#456](https://github.com/jinjunnn/alpha-code/issues/456))。
3. **21 文件 = 一个提交 = 一个决定**:审计确认这 21 个 delta 全部由 `fd357d58` 引入,是一次**真实的主权收编**(非意外漏改)。正确处置既不是天真「只改守卫」,也不是天真「全退回 seam」,而是按审计三分:被接管表面走 L3、生成文件整类修守卫口径、可避免连带退回 upstream。

## 决策

**owner 2026-07-21 批准 L3 冻结接管 permission 内核**(#456)。按 ADR-029 §3 逐要件登记:

### 1. 被接管表面(退出上游同步集,alpha 全所有权 → L3)

- `packages/core/src/permission.ts`(引擎)
- `packages/core/src/permission/**`(含 `sql.ts` 的 `permission_request`/`permission_decision` 表定义)
- `packages/server/src/handlers/permission.ts`(HTTP 契约 handler:204→DecisionReceipt、409 分支)
- `packages/opencode/src/server/routes/instance/httpapi/public.ts`(permission 契约 shim;整文件级例外,见 §3)
- 上述对应的上游测试(随源):`packages/core/test/permission.test.ts`、`packages/core/test/database-migration.test.ts`、`packages/opencode/test/server/httpapi-exercise/**`、`packages/opencode/test/server/httpapi-public-openapi.test.ts`

### 2. 为何 L0–L2 不够用(§3 要件:低级别不可行的勘探证据)

opencode **存在** permission 接缝(`plugin/src/index.ts:261` 的 `permission.ask` hook),但它**只产出 `"allow"|"deny"|"ask"` 决策**,无法改 wire 协议(fingerprint/receipt/409)、无法改既有 handler 的 reply 形状(204→receipt)、无法加 DB 持久化。REQ-090 AC3/AC8 要的正是后三者。L1 变换(磁盘不动)/ L2 补丁(loud-fail 施加)都无法轻量表达一次**引擎级重写 + 新持久化表 + HTTP 契约改形**。故 L0–L2 不可行,L3 是唯一能承载该收编的级别。

### 3. 守卫形态(§3 要件;比 ADR-020 更细)

被接管文件散落在 `core/server/opencode` 三个**仍高频同步**的包内,不能像 ADR-020 那样整包移出。`alpha-ci.yml` 的 north-star guard 从「包根路径 diff」升级为「**包根路径 - 例外 pathspec**」:用 git `:(exclude)` 显式排除 §1 列出的被接管表面。

- `public.ts` 是共享 OpenAPI 路由文件,采**整文件例外**——接受「该文件未来非 permission 改动不被守卫」的粗粒度代价,理由:它是 codegen 后的契约 shim、手改风险低。这是本接管相对 ADR-020(整包)的新机制成本,已在此定形。
- 北极星指标(升级 sync 后冲突文件数 = 0)语义不变;衡量对象缩为「真正零改的上游」。

### 4. 生成文件整类处置(守卫口径修正,非新主权,独立于本接管)

5 个 gen/快照文件(`packages/core/schema.json`、`packages/core/src/database/{migration,schema}.gen.ts`、`packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts`)是**机械产物**,SOT 是 alpha 拥有的源(Added 迁移文件 / 协议 / schema)。对它们做静态 diff 守卫,只要源合法变化就误报「上游编辑」。一并从守卫 pathspec 移出;其完整性由「生成脚本可复现(源变则重生)」保证,而非静态 diff。此项**可独立于 permission 决定**成立(纯消误报)。

### 5. B 类连带退回(4 文件,不进 L3 冻结集)

以下**不属于「拥有 permission 表面」的必需**,是 alpha 侧设计选择的可避免连带;它们都是高 churn 通用文件,冻结代价高,故**退回上游原样**(不加例外,守卫继续看着,直到退回落地):

- `packages/core/src/event.ts` —— 把事件冻结从**通用 notify 路径**移到 permission 事件的**发射点**(被接管代码内);其上游测试 `core/test/event.test.ts` 的冻结用例随之退回/迁 alpha 自有测试。
- `packages/core/src/tool/glob.ts` / `packages/core/src/tool/grep.ts` —— 让 alpha 的 wire 校验器把 `undefined` 字段**规范化为缺省**(而非拒绝),caller 无须省略。
- `packages/sdk/js/script/build.ts` —— codegen 后的 permission 类型补丁移到 **alpha 自有后置生成步**(不编辑上游 SDK build 脚本)。

各开窄 bug 票跟踪;退回落地后,守卫对 `core/server/opencode/sdk` 完全绿。

### 6. 回退方案(§3 要件)

撤销接管走 ADR-029 L3 唯一写通道 = 受控 re-freeze:用某上游 ref 覆盖 §1 被接管文件 + 从守卫 pathspec 移除例外 + 把 permission 需求降级重表达(seam/transform)。代价 = 回退 `fd357d58` 的引擎重写。

### 7. 放弃白嫖范围声明(§3 的 L3 专属要件,单向门)

§1 被接管的 permission 引擎/契约面的**上游 churn 与安全修复不再自动进入 alpha**。吸收上游 permission 改进的唯一通道 = 受控 re-freeze(逐案评估)。这是单向门,**owner 2026-07-21 明示接受**(ADR-020 已实证此代价可控)。

## 守卫盲区(留待独立裁决,非本 ADR 处置)

同提交 `fd357d58` 还改了 `packages/{protocol,schema,client}` 内的 permission 源(`protocol/src/groups/permission.ts`、`schema/src/permission.ts`、`client/src/generated/**`),但这些包**不在 `UPSTREAM_PATHS`**,守卫看不到——故 permission wire 契约的一半 SOT 在守卫之外。另 `schema/src/agent.ts` 的改动是否属本次收编**不明确**,需单独判。**本 ADR 刻意不 expand `UPSTREAM_PATHS`**(避免把 7 个未裁决文件、含 `agent.ts` 疑点仓促拉进例外)。后续独立裁决:①判这 7 个文件(收编/真漏/生成随源);②据裁决把相关包纳入 `UPSTREAM_PATHS` 并对收编项加例外。跟踪:[#456](https://github.com/jinjunnn/alpha-code/issues/456)。

## 后果

- ✅ #433 的 permission 收编获得合法 **L3 身份**;守卫对被接管 + 生成文件停止误报,北极星机械可验证性对「真正零改的上游」仍成立(系统化而非放宽,同 ADR-029 立场)。
- ✅ 代码 PR 不再因 permission 收编而需 `--admin`;**B 类 4 文件退回落地后守卫完全绿**。
- ⚠️ **单向门**:permission 引擎脱离上游同步(含安全修复),re-freeze 是唯一吸收通道。
- ⚠️ `public.ts` 整文件例外 = 该文件未来非 permission 改动不被守卫(粗粒度代价,已接受)。
- 🔭 待办:① B 类 4 文件退回(窄 bug 票,守卫全绿前置);② 守卫盲区 7 文件裁决 + `UPSTREAM_PATHS` 扩展(#456);③ 审计文档落库(本 PR)。
