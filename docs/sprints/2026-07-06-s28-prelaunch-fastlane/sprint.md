# Sprint 2026-07-06 S28 —— 放量前快车道(REQ-048 + REQ-039 方案)

> **抽取(2026-07-06,用户拍板「按三个 sprint 推进」)**:三 sprint 弧之 ①。
> 弧:**S28(本批,无需用户在场)** → **S27 场次二**(既有契约 T3 残余 + T4–T6,等用户在场,不重开新号)→ **S29 v0.1.1 真实发版**(候选,前置 = 场次二收尾;收 B9 更新链 + B7 ①③⑤)。
> **WIP 注记**:S27 尚开(场次二用户门控)——S28 与其并行由用户本次指令豁免 WIP=1;S28 范围与 S27 零文件交集(纯 C 侧 + B 侧方案)。
> **性质**:快车道(REQ-048)+ 方案立项(REQ-039,动手前须用户拍板二选一)。

## 目标

1. **REQ-048(C,P3 debt)落地**:catalog-src 逐条补显式 per-entry version(内容真变才 bump)→ 消 placebo 更新角标;顺带消除 S27 场次二验证噪音(已安装角标用例不再被污染)。A 零动作(快照随下次 ship 刷新,归 S27 场次二/S29)。
2. **REQ-039(B,P1 feature)方案收口**:勘探 edition 闸 × 管线默认模型的病灶与两案成本(a. 管线模型按租户 edition 动态选择 / b. cn 白名单纳入执行模型),出方案简报 → **用户拍板** → 视体量本批内实施或转下一批。

## Task 表

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T1 | 三线勘探:A 角标机制 / C 发布链 / B REQ-039 病灶 | 结论带 file:line 证据 | ✅(三线结论在册,B 线多挖出第三案 c) |
| T2 | REQ-048 实施:catalog-src 逐条补 version → build(warn 清零)→ PR → 部署 → prod 复验(验签 + 角标语义确认) | 联网用户角标不再误亮;A 零动作 | ✅(alpha-web PR #12;catalog 2026-07-06.4;build 守卫升硬失败+红绿演练;prod 验签 VALID+sha256 MATCH;旧 receipts 熄灯残留记档) |
| T3 | REQ-039 方案简报 + 需求档(`requirements/REQ-039-*.md`)+ 拍板请求 | 两案落点/成本/风险明确;用户拍板 | ✅(三案简报入档;**用户拍板「c 案 + a 留册」**,b 否决) |
| T4 | (拍板后,若为小改)REQ-039 实施 + dev e2e 验证;否则转下一批契约 | e2e:cn 租户 schedule/research 管线不再 edition_forbidden | ✅(alpha-platform PR #19 + prod 部署;dev e2e 绿证 + 闸分支 3 单测 + picker 零泄漏 smoke) |
| T5 | 收尾回写:BACKLOG 翻状态 + CHANGELOG + 本契约结果 | 四件套 | ✅(REQ-048/039 翻 shipped;REQ-049 立项留册;CHANGELOG 两条;docs PR) |

## Gates

- REQ-048 部署前:build-catalog.mjs 无 version warn + 顶层版本单调 bump + 签名复验通过;
- REQ-039:**未拍板不动代码**(⚖️ 纪律);拍板结论回写需求档;
- 真机验证类一律不入本批(归 S27 场次二)。

## 明确不做

- 不动 A 仓运行时代码(REQ-048 A 零动作;快照刷新随下次 ship);
- 不做 REQ-009 partial-clone 真 CI 验证(需专门红绿探针 PR,不与本批混流);
- 不预启 S29(前置 = 场次二收尾)。

## 结果(收尾回填,2026-07-06)

- **REQ-048 shipped+prod(alpha-web PR #12,catalog 2026-07-06.4)**:23 条补显式 `version:"1.0.0"` + build-catalog.mjs 缺 version 从「顶层日期回填+warn」升级为**拒绝构建**(红绿演练 PASS);prod 复验 = 验签 VALID(A 侧内置公钥)+ 28 条全显式 + 资产 sha256 抽样 MATCH。**勘探修正原判**:存量 receipts 记的是日期版 → 补 1.0.0 后旧 receipts 误亮修复,但对未来 1.0.x 真更新永久不亮(装机面≈开发机,重装即自愈,记档接受);A 侧 `versionLess`/`entryVersion` 零单测锁 = 低优先残项。
- **REQ-039 shipped+prod(alpha-platform PR #19,用户拍板 c 案)**:勘探核心发现 = `/v1/messages` 闸早已豁免内部凭证而 chat/completions 闸漏了(两闸不对称即根因);修 = `editionGateApplies(via)` 单源接三处闸;闸 via 分支补 3 单测(此前零覆盖 = 漏网原因),270/270 绿;dev e2e 绿证(cn 配置下 dev 凭证跑通 claude-sonnet 完整补全 + picker 零泄漏);prod 部署 + smoke。**verified 待**真实 cn 租户复验(放量前)。
- **REQ-049 立项留册**(a 案:per-edition 选模,代付 ~6x 降 + 数据流向国内;放量后按用量触发)。
- 状态翻转:REQ-048 → shipped(verified 待 S27 场次二角标顺带)· REQ-039 → shipped(verified 待 cn 真实租户)· REQ-049 → registered。
- 下一步:S27 场次二(等用户在场)→ S29 v0.1.1 真实发版。
