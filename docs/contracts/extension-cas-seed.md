---
title: Extension CAS, packaged seed and GC (REQ-102 A-side)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-16
review_after: 2026-10-13
---

# Extension CAS, packaged seed and GC(REQ-102 A 侧消费契约)

本文钉住 alpha-code(A)对 alpha-web(B)`contracts/extension-seed/CONTRACT.md`
(landed @ alpha-web `2a4c4f7`,schema `alpha.extension-seed.lock.v1`)的消费端实现边界,
以及 main-owned CAS 与 mark/sweep GC 的布局/生命周期承诺。B 侧合同本体归 alpha-web 仓;
本文只拥有 A 侧落点。上游决策脉络:ADR-028(schema/planner/receipts)、REQ-100
(事务引擎)、REQ-101(signed channel 链)。

## 1. 三层状态分离(布局即契约)

| 层 | 根 | 生命周期 | 所有者模块 |
| --- | --- | --- | --- |
| CAS blob(不可变内容,media-type-neutral) | `<base>/cas/v1/sha256/<aa>/<64hex>`(base = `~/.alpha` 基根,**跨环境共享** —— prod/beta/dev 同 payload 只占一份磁盘,parent AC2) | 由 mark/sweep GC 管理;blob 可随时按 digest 重建 | `ext-cas.ts` |
| 安装态(receipts / generations / journal / grants) | REQ-098 环境 mutable root(`<base>` dev / `<base>/env/prod` / `<base>/env/beta`) | REQ-099 账本 + REQ-100 事务引擎(有界代数保留) | `ext-receipt-v2.ts` / `ext-transaction.ts` |
| 用户数据(workspace / secrets / 会话 / 导入源) | 各自既有根 | **任何 CAS/GC 路径在构造上不可达**;GC 唯一删除面 = 严格 blob 命名 + realpath 圈禁的 CAS 文件 | — |

CAS 补充语义:

- blob 按 sha256 寻址,无扩展名、无格式假设;archive 形态由 ManifestV2 `artifact.mediaType`
  声明(ADR-028 §3),CAS 层永不解包。
- 写入 = 先全量 digest 校验(不符 → 零副作用拒绝)→ tmp → fsync → rename(`ext-atomic-fs`
  原语,与事务 staging 同纪律);读取重验,损坏 loud 拒绝(本地篡改不静默采信)。
- 显式 pin 账 `<base>/cas/v1/pins.json`(GC mark 根之一)。
- **catalog skill 安装同走 CAS(REQ-098 #303)**:remote(下载层逐文件 sha256 对 catalog 清单钉死)
  与 builtin(摄取时自算内容地址 —— 完整性/一致性,不主张独立上游真实性;聚合 payloadDigest 落
  receipt)及 bundle skill children,一律 put 前结构校验(载荷↔清单按 path 一一对应、拒重复/缺/
  多/不安全路径、bytes 精确)→ 提升进共享 CAS → generation staging 由 `populateFromCas` 物化
  (读取重验)。`installSkillGeneration` 内容源收紧为 **CAS-only**(buffer 直填旁路移除;journal
  只存 TxFileSpec 与来源无关,恢复语义不变)。bundle 的 promotion 在 classify/计划期锁外执行
  (CAS 是可重建缓存层,不属 bundle 安装态原子边界):required child 失败 = 整 bundle 拒,
  optional = skipped;blob 被外部删除 → materialize abort(无 buffer 回退通道)。

## 2. packaged seed 消费顺序(B 合同 §6 的 A 侧规范实现)

1. **快照期(= 合同「打包(release CI)」步)**:`packages/ui-mac/scripts/sync-extension-seed.mjs`
   从 B 已发布面(远端或 `--from-dir <alpha-web checkout>`,逃生不逃验签)执行:
   - §2 交叉复核:内置公钥 → trust → stable 指针 → payload 全链验签(S1–S4),
     `lock.catalog.sha256/bytes` 必须等于已验签 stable target;lock 逐资产逐文件与 payload
     `remoteAsset` 清单逐字对齐,任一不符 → **拒绝整个 seed**;
   - §4 同语义门:S5 路径 / S6 symlink·realpath / S7 许可 allowlist + redistributable /
     S8 第三方许可文本 / S9 平台 / S10 预算再执行 / S11 blob 逐字节 / S12 输出 symlink;
   - 全过才写 `packages/ui-mac/resources/extension-seed/`(lock/NOTICE 字节原样 + blob 按
     CAS 同构布局去重 + 确定性 meta,零时间戳,二连跑 diff 为空)。
   漂移守卫:`src/main/extension-seed-snapshot.test.ts`(S13 A 侧)—— 严格解码、逐 blob
   重哈希、快照 meta 钉合、**与内置 catalog 快照互钉**(`lock.catalog.sha256 ==
   alpha-catalog.json` 字节 sha256:stable 晋级后两个快照必须同步再生,否则 `bun test` 红)。
   打包落点:electron-builder `extraResources` → `<process.resourcesPath>/extension-seed`。
2. **运行期浏览(纯读)**:`ext-seed.readPackagedSeed(seedDir)` —— lock 严格解码(未知顶层键
   = 降级混淆,拒绝)、S10 预算按 lock 记录同值再执行、S9 平台门(当前平台 ∉
   `supportedPlatforms` → 整个 seed 拒绝);产出可浏览资产视图(availability 恒 `bundled`,
   与激活态正交)。**不安装、不启用、零配置写入、零进程、零网络**(parent AC1/AC3)。
   浏览面 IPC(#316):`ext-seed-browse` → `packagedSeedBrowseView` 安全投影 —— 只透元数据
   (id/type/version/license/source/bytes/fileCount/platformCompatible),**零绝对路径、零
   blob 布局、零 url**;seedDir 由 main 派生,renderer 无输入;Hub UI 归 REQ-103。
3. **安装提升(用户显式动作;#317 起为生产链路)**:入口 = `ext.installCatalog` 的 seed
   判别意图(`{source:"seed", assetId, scope}`,与 catalog 意图互斥、未知键拒;seedDir/CAS
   根/清单/版本/receipt 语义全 main-owned)。序:`readPackagedSeed` 严格读 → **回表同包
   bundled catalog entry**(绝不 effective remote/cache;id/type/version/逐文件
   path+sha256+bytes/聚合 payloadDigest/lock.catalogVersion 逐项交叉一致,任一漂移
   fail-closed)→ `verifySeedAsset` 两遍式(S6 symlink/realpath、S9、S10、S11 逐文件
   sha256/bytes,**展开前拒绝**)→ `promoteSeedAssetToCas` 把**所选资产**的 blob 原子提升
   进共享 CAS(不复制整个 seed)→ REQ-100 generation 事务从 CAS 物化(`populateFromCas`,
   读取重验,缺失/篡改 = staging abort:零 live/staging/generation 残留,终态 aborted
   journal 按引擎语义保留作恢复/审计证据)→ receipt v2 落账(语义派生自 bundled
   entry;`ownership.distributed` 如实记 `bundled`)。边界:**skill + agent,global-only**
   (mcp/plugin → #359);skill 版本门在**引擎 Bundle 锁内**经 precondition hook
   执行(锁外判定有 TOCTOU):账本 strict 四态,损坏/已装无版本/不可比/更高已装一律
   fail-closed 拒,同版本重装幂等;安装**不 pin**(generation content rehash 即 GC mark
   root,#318)。
   **agent seed(#358,2026-07-16 Codex 裁决)**:共享回表/交叉/CAS promote 后按类型分派到
   `installAgentFromCas`(`ext-agent-install.ts`)—— 一次 `runExtensionTransaction`,
   file item(`ext-file-tx` journaled 原子替换 `<root>/agents/<name>.md`,root 内受控相对
   路径,调用方绝对路径无通道)+ config item(`agent.<name>` 叶,`agentMdToEntry` 单一
   解析真源)双 item 单事务,全提交或全回滚。装约定:恰一顶层 `.md`、≤256KB、
   `entry.id === "agent:"+entry.name` 一致性校验;内容字节 = CAS blob 原样(byte-exact)。
   fresh-only 门在**锁内 precondition**(agent 无更新链):账本 strict(v2/v1 在场拒)+
   md 文件(含 legacy `agent/` 单数目录)/ config 叶在场一律拒,config 不可读 fail-closed。
   capabilities 走严格解码 manifest → #348 锁内授权闸(授权 key 归 file 主 item,
   `agent--<name>`;config 副 item **不声明** capabilities,不参与授权评估也不落授权账)。
   卸载(flat 通道)联动清除 `ext-store/agent--<name>[--config]/grants.json`(删除失败 =
   卸载失败且账本不动),重装重新弹确认。
   **mcp seed(#359,2026-07-16 Codex 裁决)**:共享回表/交叉/CAS promote 后分派 config action
   单事务(`mcp--<name>` item 写 `mcp.<name>` 叶)—— 安装语义派生自 bundled entry 的
   `installSpec`,**CAS blob 只是离线携带字节,不是运行载荷**:本通道只承诺「离线完成配置
   安装」,local npm/uvx MCP 首次运行仍可能联网(诚实边界)。phase-1 fail-closed:seed intent
   无 grants 通道 —— secret-bearing(requiredEnvVars)/ workspace 占位 / Excel 族一律拒;
   纯 validator(`validateServer`,零写盘)在 plan 生成前跑命令头/inline-eval/URL/危险 env
   安全门。锁内门 = 账本写前探测 + 版本门(kind 泛化:downgrade/不可比拒,同版本幂等)+
   无账 config 叶拒认领 + 形状异常 fail-closed。成功 outcome 返回 `liveMcp`(renderer 据此
   live `sdk.mcp.add`;无密钥 → live = durable 原样)。事务内绝不触 `persistMcp`/
   `withConfigWriteLock`(非重入自锁)。
   **plugin seed(#359)**:CAS 字节 = 离线运行载荷(payload 必含顶层 `plugin.js`;npm plugin
   显式拒 —— 无 seed blob 保证的离线运行语义)。staging 为**确定性内容寻址**目录
   `plugins/<name>@<payloadDigest 前 12 位>`(temp 物化逐 blob 重验 → 原子 rename;同 digest
   命中 = 逐文件重验后复用,缺失/篡改 fail-closed 拒;非提交返回路径 best-effort 清理,崩溃
   残留至多一个同 digest 无引用目录,识别/清理见 runbook)。安装**接 #352 三态**:absent →
   fresh(config action 追加 plugin[] 元素,锁内 precondition 重读账本/config/bare 目录);
   有效 catalog 旧账 → journaled replace(与 #352 同一事务,staging 源换 CAS);v1-only/损坏/
   双键/账配漂移 → 拒;same-version healthy 幂等早退;更高已装拒 downgrade。
   **卸载授权账合同(#358/#359)**:经事务授权闸安装的类型(agent/mcp/plugin)卸载联动清除
   `ext-store/<key>/grants.json`,且为成功前置(mcp 在 journaled artifact seam 内,失败保持
   非终态前滚;agent/plugin 在 flat 通道,失败 = 卸载失败且账本不动)。
   **file 落盘圈禁与残余竞态(r3 裁决)**:`confineFileTarget` 逐段 lstat 拒 symlink,在
   prepare、`applyFileImage` 前、每次 `restoreFileImage` 前(在线回滚与崩溃恢复)以及恢复
   期任何对 journal file 段的采信(isFlipped/probe/receipt replay)之前**紧邻重验**;重验
   不过 = 事务保留非终态(零写入、零落账)。接受的残余窗口 = 单次「lstat 重验 → 原子写」
   之间的微秒级 check-then-use 竞态(与 GC promote 窗口同类,§3):被利用的后果上界是一次
   写入被并发重绑定劫持,后续任何恢复/采信都会被重验拦下并保留非终态留证,不会静默扩散。
4. `url` 字段仅传输提示;任何来源的字节一律以 digest 为唯一权威。

## 3. mark/sweep GC(`ext-cas-gc.collectCasGarbage`)

- **mark 根**(任一不可读 → 整轮拒绝,fail closed):
  1. 各环境根事务 journal(全状态;未完成事务的期望清单即在其中);
  2. 各环境根 `ext-store` 全部 generation 内容重哈希(current/previous/pinned generation ⇒
     receipts 可达性的机器形态);
  3. packaged seed lock(seed target 保留 —— 离线重装/修复可用);
  4. `pins.json` 显式 pin。
- **sweep**:只删「blob 命名双守卫(64hex + 分片一致)∧ realpath 圈禁于 CAS 根 ∧ 未 mark ∧
  出宽限窗(默认 6h,mtime)」的常规文件;未知条目 / symlink / 异位文件一律保留 + loud。
  **用户数据在任何情况下不可达**(负向测试钉死)。
- **互斥与恢复语义**:GC 先持 CAS 级锁(GC 对 GC 串行),再逐环境根持 REQ-100 Bundle 锁 ——
  任一环境有活事务 → 整轮如实跳过(非阻塞);陈旧锁走 `ext-bundle-lock` 既有 stale 恢复。
  sweep 期间新事务无法启动;blob 彼此独立 ⇒ 任意崩溃点后 store 自洽,下一轮从头 mark。
- **可观测**:`dryRun` 返回完整 sweep 计划(逐 digest/bytes)与 `keptByGrace` 计数,零删除。
- **生产触发(REQ-102 #318,`ext-cas-gc-scheduler.ts`)**:启动后 5 分钟首跑,此后 24 小时一轮
  (单次 schedule → run → finally 链式 rearm,不重叠、异常不断链;睡眠错过的周期由下一 timer
  自然补一轮,无 catch-up storm);锁忙 / mark 根损坏 = 本轮如实记录等下轮,零重试风暴。配置经
  唯一权威取值点 `productionCasGcConfig`(已单测):冻结共享 CAS 基根 + dev/prod/beta 三环境根
  (固定顺序)+ **当前 package 的 seed lock 无条件传入**(缺失 = 整轮 fail-closed,不静默退化;
  seed mark = 本进程 package 的 seed,不是同机全部 app 版本的并集)+ 显式非零 grace(6h)。
  每轮写结构化计数摘要(outcome = success / busy-skip / fail-closed / exception;不落完整
  swept 路径)。多实例(prod/beta 同机)由共享 CAS 跨进程 GC 锁串行化,busy-skip ≠ 漏跑,无需
  错峰。**「running-lease」保护的机械形态** = GC 在整个 mark+sweep 期间持有各环境根同一把
  `tx.lock`(活事务占锁 → 整轮零删除;stale 锁留证恢复后才允许 GC)+ 获准事务的 journal digest
  为 durable mark root —— 锁是互斥屏障,journal 才是 mark 数据。**锁心跳按进度续租**(每
  journal 段 / 每 generation key rehash 后 / sweep 每 64 blob):长轮 GC 不会因心跳超
  staleMs(15min)被其它进程按 stale 接管;续租粒度 = 单段操作时长(单 key 巨型 store 的
  rehash 超阈值是已知粒度限制,如实记录)。**promote 窗口**:复用出-grace
  cold blob 的 put 会刷新其 mtime(残余竞态 = GC 单轮 lstat→unlink 微秒级;后果为安装
  materialize fail-closed abort,可重试、无损坏)。**project 根不参与 mark = 合同行为**
  (ADR-030 / #362 裁决:project-scoped catalog/seed generation 已收回,受支持的 catalog
  generation 仅存在于 dev/prod/beta 环境根 —— 见 §6;#318 完成矩阵的 project 项由验收
  owner 按该措辞修订)。

## 4. 兼容红线

- lock schema 演进(`…lock.v2`)= 消费端遇未知顶层键必须拒绝(已实现);B 侧
  budget / 许可 allowlist / 平台 allowlist 变更 = 契约变更,须同步
  `ext-seed.ts` 常量、`sync-extension-seed.mjs` 与本文件。
- CAS 布局(`v1/sha256` 分片)升级 = 新版本目录并存迁移,不原地改写。
- 本契约不改变 catalog-channels 消费面(`catalog-channels.ts`)的任何字节或语义;
  seed 快照与 catalog 快照互钉是纯增量守卫。

## 5. 守卫测试索引

| 面 | 测试 |
| --- | --- |
| CAS put/read/materialize fail-closed | `packages/ui-mac/src/main/ext-cas.test.ts` |
| seed 严格解码 + S5–S11 负向 + 提升两遍式 | `packages/ui-mac/src/main/ext-seed.test.ts` |
| GC mark 根/互斥/宽限/用户数据不可触 | `packages/ui-mac/src/main/ext-cas-gc.test.ts` |
| 快照漂移(S13 A 侧)+ catalog 互钉 + 真链冒烟 | `packages/ui-mac/src/main/extension-seed-snapshot.test.ts` |
| seed 安装生产链(#317:e2e / 双真源漂移拒绝矩阵 / CAS 注错 abort / XOR / downgrade 门;#358:agent e2e / authorize 单 key / fresh-only 三态 / 装约定拒绝矩阵 / 卸载清授权账;#359:mcp e2e+liveMcp / 纯 validator 负测 / secret·workspace·Excel 拒 / plugin 确定性 staging / #352 三态矩阵 / npm 拒 / 篡改拒) | `packages/ui-mac/src/main/ext-seed-install.test.ts` |
| file action 引擎语义(#358:file+config 原子 / 缺席≠零字节 / 崩溃恢复前滚·回滚 / 旁路改写 fail-closed) | `packages/ui-mac/src/main/ext-transaction-file.test.ts` |
| GC 生产触发(#318:调度语义 / 权威配置取值点 / outcome 分类;promote 窗口 mtime 回归在 gc.test) | `packages/ui-mac/src/main/ext-cas-gc-scheduler.test.ts` |
| project 收回:catalog/seed/bundle 统一拒绝 + 遗留管理面 + generation teardown(#372) | `packages/ui-mac/src/main/ext-install-planner.test.ts` |
| project 残留检测/显式清理(journal 在场 fail-closed / 幂等 / 移动项目单项拒) | `packages/ui-mac/src/main/ext-project-residuals.test.ts` |
| 第一方六动作 wiring:installCatalog intent 恒 scope=global | `packages/ui-mac/src/renderer/extensions/install-scope-wiring.test.ts` |

## 6. project scope 收回(ADR-030,REQ-098 #362/#372)

- **新增安装**:`installCatalog` 在 decode 后、resolveEntry/seed 分流与任何副作用之前统一拒绝
  `scope=project`(catalog / seed / bundle 三形态同一合同),稳定 reason:
  `project-scoped catalog/seed installation is unsupported — use project-local import/register`;
  wire/decode 形状保留(协议不破坏),`resolveScope` 另有防御性拒绝。项目本地技能能力
  不受影响 —— 走 `<project>/.alpha/skills` + project config hook 的非 generation 路径。
- **遗留管理面独立**:卸载/禁用的 project allowlist(skill/agent)与安装策略分离,
  绝不因收回而封死残留清理;project skill 残留带 generation store 时,卸载走 journaled
  store+ledger teardown(删受控 `ext-store` + 对应账本),不落 flat 删除。
- **残留处置**:项目打开位点(`ext-external-check`)只读 loud 报告;
  `ext-project-residuals-check`(只读)/`ext-project-residuals-clean`(显式)双通道。
  清理的可证明性前提(任一失据即**整单拒**,零自动删除、零全盘扫描):账本文件可读、
  相关 key 无损坏 record、无不可归属损坏 record(`lookupForUninstall` 四态)、journal 目录
  可枚举且无非终态/不可读 journal(清理起步前重巡检一次)。可清理面 **只有两类**:
  ① project-identity 的 catalog record(identity 不符单项 fail-closed);② 账本判 absent 且
  形状为 `skill--<safe>`、具 generation-store 结构的 ghost 店。其余一律只报告:非该形状的
  ext-store 条目、误置(非 project scope)record、v1 占位、以及 orphan agent 面
  (`.alpha/agents/*.md`、`alpha.jsonc` agent 条目)—— 永不自动清。
