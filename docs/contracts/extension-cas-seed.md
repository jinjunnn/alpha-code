---
title: Extension CAS, packaged seed and GC (REQ-102 A-side)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-15
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
   entry;`ownership.distributed` 如实记 `bundled`)。边界:**skill + global-only 首期**
   (agent → #358,mcp/plugin → #359);版本门在**引擎 Bundle 锁内**经 precondition hook
   执行(锁外判定有 TOCTOU):账本 strict 四态,损坏/已装无版本/不可比/更高已装一律
   fail-closed 拒,同版本重装幂等;安装**不 pin**(generation content rehash 即 GC mark
   root,#318)。
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
  为 durable mark root —— 锁是互斥屏障,journal 才是 mark 数据。**promote 窗口**:复用出-grace
  cold blob 的 put 会刷新其 mtime(残余竞态 = GC 单轮 lstat→unlink 微秒级;后果为安装
  materialize fail-closed abort,可重试、无损坏)。**project scope 根尚未参与 mark**(无
  project 根枚举来源;生命周期裁决 → #362,结论回写 #318 完成矩阵后才可判该 AC PASS)。

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
| seed 安装生产链(#317:e2e / 双真源漂移拒绝矩阵 / CAS 注错 abort / XOR / downgrade 门) | `packages/ui-mac/src/main/ext-seed-install.test.ts` |
| GC 生产触发(#318:调度语义 / 权威配置取值点 / outcome 分类;promote 窗口 mtime 回归在 gc.test) | `packages/ui-mac/src/main/ext-cas-gc-scheduler.test.ts` |
