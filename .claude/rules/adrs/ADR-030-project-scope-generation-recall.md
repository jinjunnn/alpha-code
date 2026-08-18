# ADR-030:收回 project-scope catalog/seed 受管安装(保留遗留清理通道)

- 状态:accepted(2026-07-15,Codex 裁决 + #362 DECIDE 收口)
- 关联:ADR-028(Registry v2 / main-only 安装计划)、REQ-098(#209)、#303/#318 完成矩阵、派生实现票见 #362 评论
- 决策记录真源:本文;A 侧契约落点随实现票更新 `docs/contracts/extension-cas-seed.md`

## MCP-only carve-out(2026-08-17,REQ-136 #1013 / DECIDE #1014)

本 ADR **不整体废止**。REQ-136 只批准一个窄例外:main 从已验真源解析出的独立 catalog MCP,
以及 type 与 bundled catalog 同为 MCP 的 packaged seed 资产,可按
[`docs/design/req-136-project-mcp-install.md`](../../../docs/design/req-136-project-mcp-install.md)
进入 project scope。两者都必须是 `<project>/.alpha/alpha.jsonc` 的 config-only 事务;
project seed 只做零写入字节校验、不提升 CAS。需密钥、当前 workspace-policy、bundle/package、
plugin/cloud 及未点名形态仍拒绝;skill/agent 的新增 project catalog 安装拒绝与遗留清理通道原样保留。

下文的全称「project catalog/seed 收回」是本 carve-out 之前的历史基线,此后须与本节合读。
在对应 CODE 合入前,运行时仍以当前 broad guard 的全拒绝为真;不得只放开 Hub 开关,也不得仅把
`mcp` 塞进遗留管理 allowlist。发现、按项目 lazy recovery、root-parametric 卸载、同名 shadow
披露与零 CAS 行为闸必须同批落地。

## 背景

planner 允许 project scope 的受管安装(`PROJECT_SCOPED_KINDS = {skill, agent}`,事务根切
`<project>/.alpha`):skill 走 generation/CAS 事务,agent 走 flat 文件 + `alpha.jsonc`。
但 project generation 的生命周期三缺口为既有阻断(2026-07-15 #303 Codex 裁决点名):

1. **发现**:运行时 generation 注入固定 `injectSkillGenerationPaths(cfg, globalAlphaRoot)`
   (packages/ext/src/plugin.ts),`<project>/.alpha/ext-store` 永不进 `skills.paths`——装了不可用。
2. **恢复**:生产恢复唯一入口 `recoverExtensionTransactions(alphaGlobalRoot(), …)`(ext-ipc.ts),
   项目根 journal 永不恢复。
3. **GC**:CAS mark/互斥根只有 dev/prod/beta(ext-cas-gc.ts `defaultCasGcEnvRoots`),
   project 事务不在 GC 互斥集合;仅被 project generation 引用的 blob 过 grace 可被 sweep。

裁决输入(已核查):

- 第一方 renderer 六个 `installCatalog` 生产调用点全部硬编码 `scope: global`
  (use-extensions.ts ×5 + extension-hub.tsx bundle);但 preload/wire 仍公开 project intent
  形状,main 也接受——"零 project"只是当前第一方调用图,不是拒绝语义。
- 真实的项目技能产品能力已有独立路径:`importExternalSkills(project)` 写
  `<project>/.alpha/skills` + `registerProjectSkillsPath` 注册 `./.alpha/skills`,
  经 project config hook 发现——不经 CAS/generation/事务 journal,不受本缺口影响。
- CAS 物化 = 全字节拷贝(`materializeFilesFromCas`),已物化 generation 与回滚都不依赖
  CAS blob 存活;blob 被 sweep 的代价是未来重装/去重,另有 promotion→物化窗口的已记录
  竞态(ext-cas.ts:79,现场 fail-closed abort)。
- project generation 卸载当前落到 flat `removeFsInstall`(planner 的 generation-aware
  卸载分支限 global skill),会去账但遗留 `ext-store`——即"可安装、不可用、不可恢复、
  不可完整清理"的假能力。

## 决策

**收回新增 project-scope catalog/seed 受管安装(fail-closed 拒),skill/agent 对称;
遗留检测与清理通道保留。**

1. **拒绝点** = `installCatalog` 完成 decode 后、`resolveEntry`/seed 分流与任何副作用之前的
   统一 planner policy guard;`resolveScope` 保留防御性拒绝(seed/bundle 分支不走普通
   `resolveScope`,不能只靠它)。**不在 decode 层拒**:wire 形状保留,避免协议破坏。
   稳定 reason:`project-scoped catalog/seed installation is unsupported — use project-local import/register`。
2. **策略拆分,不清空共享常量**:"新增安装策略 = 无 project kind" 与 "遗留可管理
   kind = {skill, agent}" 分开;`PROJECT_SCOPED_KINDS` 同时守卫卸载/禁用,清空会封死
   残留清理。
3. **残留处置**:不能假设现网零残留(测试即证明 project skill generation 可成功创建;
   dev 构建/直连 IPC 可能留状态)。项目打开或显式检查时**报告**残留
   (`installs.json` 中 scope.kind=project 且 origin=catalog、`ext-store/skill--*`、
   `ext-tx/journal`、agent 的 `.alpha/agents/*.md` 与 `alpha.jsonc` agent 条目);
   无在途 journal 时提供幂等、受控根内的 generation-aware 清理(删受控 `ext-store` +
   对应账本,不再落 flat `removeFsInstall`);journal 在场或身份不匹配 = fail-closed,
   零自动删除,不做全盘扫描。
4. **重返路径**:将来真实需要 project catalog 受管安装时,立新 REQ 带完整生命周期设计
   回来(发现注入、按项目 lazy recovery、GC 跨项目根契约、capability 验证),不在本决策内。

## 后果

- #303 完成矩阵 project 项与 #318 project retention root 项,在**拒绝代码合入 + 残留策略
  落地后**,由验收 owner 按以下措辞修订为 N/A-by-contract(当前基线不得直接宣告):
  - #303:Project-scope catalog generation — N/A-by-contract:新增 project-scoped
    catalog/seed 安装在 planner 写盘前稳定拒绝;项目本地技能继续走
    `<project>/.alpha/skills` + project config hook 的非 generation 路径。
  - #318:Project retention root — N/A-by-contract:受支持的 catalog generation 仅存在于
    dev/prod/beta 环境根;project-scoped catalog/seed generation 不再是受支持能力,
    历史残留按显式检测/清理策略处置,不建立长期 project GC root registry。
- 发现/恢复/GC 三缺口在新契约下判 N/A;`.alpha/skills + alpha.jsonc` 项目能力不受影响。
- 实现票验收要点含:六个第一方生产动作的 wiring test(捕获 `installCatalog` intent 断言
  `scope=global`)、project skill/agent 拒绝回归、bundle/seed 同一拒绝合同、global 行为不变。
