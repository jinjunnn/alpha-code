# REQ-102 A 侧取证:Extension CAS + packaged seed + mark/sweep GC(2026-07-13,S49)

- Issue:jinjunnn/alpha-code#194(parent jinjunnn/alpha-work#5)
- 分支:`feat/194-req102-seed-cas`(worktree,基于 origin/alpha @ 3bdc5b90)
- B 侧输入:alpha-web `contracts/extension-seed/CONTRACT.md` + `seed-lock.v1.schema.json`
  (landed @ alpha-web `2a4c4f7`);消费契约 A 侧落点:`docs/contracts/extension-cas-seed.md`
- 交付模块:`packages/ui-mac/src/main/ext-cas.ts` / `ext-seed.ts` / `ext-cas-gc.ts`、
  `packages/ui-mac/scripts/sync-extension-seed.mjs`、`packages/ui-mac/resources/extension-seed/`
  (快照入仓:seed.lock.json + NOTICE.md + 98 blobs,5,670,465B,catalogVersion 2026-07-13.1)、
  `electron-builder.config.ts` extraResources(→ `<resourcesPath>/extension-seed`)、
  `ext-ipc.ts` 启动期只读 seed 摘要日志

## 1. 门禁结果(本机,2026-07-13)

```
▶ [1/3] north-star guard (zero upstream edits)
    ✓ zero upstream package edits
▶ [2/3] typecheck (alpha packages: ext + ui-mac)
    ✓ typecheck
▶ [3/3] unit tests (ext + ui-mac)
 73 pass / 0 fail          (packages/ext)
 1295 pass / 0 fail        (packages/ui-mac, 87 files)
✅ all local gates green — safe to push (alpha-ci will mirror this in ~40s).
```

```
== simulating restore_frozen_frontend from frontend-freeze-base-3 in a temp worktree ==
OK: seam and all anchors survive restore from frontend-freeze-base-3; restored trees match HEAD freeze set
```

快照同步幂等(门禁口径:二连跑 diff 为空):

```
$ node scripts/sync-extension-seed.mjs --from-dir /Users/tide/app/alpha-web
✓ extension seed 2026-07-13.1: 5 assets, 98 blobs (5670465B) ← alpha-web-checkout
$ node scripts/sync-extension-seed.mjs --from-dir /Users/tide/app/alpha-web
✓ extension seed 2026-07-13.1: 5 assets, 98 blobs (5670465B) ← alpha-web-checkout
$ git status --porcelain packages/ui-mac/resources/extension-seed | wc -l
0
```

lock/NOTICE 与 B 侧发布面字节一致(`cmp` 零差异);docs 契约检查
(`check_docs_contract.py --strict`,alpha profile)对本分支 PASS。

## 2. 新增安全负向覆盖(全绿)

| 套件 | 数量 | 覆盖 |
| --- | --- | --- |
| `ext-cas.test.ts` | 14 | digest 不符零副作用拒绝、读取重验(篡改 loud)、symlink 源/条目拒绝、materialize traversal/绝对路径/缺 blob/损坏全拒、幂等、损坏 blob 原子替换 |
| `ext-seed.test.ts` | 19 | 未知顶层/资产键(降级混淆)、S5 traversal、S7 许可/redistributable、S8 第三方缺许可文本、S9 平台 token/混用/无交集/乱序、S10 三预算再执行、总量一致性、确定性排序、symlink lock、S6 blob/父目录 symlink + realpath 逃逸、S11 尺寸/digest 展开前拒绝(两遍式零写入)、提升幂等、不复制整个 seed |
| `ext-cas-gc.test.ts` | 9 | 四类 mark 根(journal/generation/seed lock/pin)可达即留、宽限窗、dry-run 零删除全计划、活事务锁整轮跳过、并发 GC 串行化、坏 journal/坏 seed lock fail-closed、未知条目/symlink/异位 blob 保留 + loud、环境根用户文件零触碰 |
| `extension-seed-snapshot.test.ts` | 5 | 入仓 lock 过消费端严格解码、meta 钉合、**与内置 catalog 快照互钉**(S13 A 侧:stable 晋级只再生其一即红)、blob 目录与清单精确互等(逐 blob 重哈希 691 断言)、真实消费链冒烟(浏览纯读 + 逐资产验证 + 临时 CAS 提升) |

## 3. 关键设计事实(与合同/父需求对齐)

- **信任面**:lock 无独立签名 → 快照期全链交叉复核(内置公钥 → trust → stable → payload
  验签,lock.catalog 与逐文件 digest 对齐已验签清单,任一不符拒绝整个 seed);运行期导入
  面逐文件 digest 重验;`url` 仅提示。
- **状态分离**:CAS = `<base>/cas`(跨环境共享,AC2)/ 安装态 = env root / 用户数据不可达
  (三层边界见 `docs/contracts/extension-cas-seed.md` §1)。
- **seed 只进浏览面**:运行期消费 = `readPackagedSeed` 纯读 + 启动摘要日志
  (`[req102-seed] … (browse-only, not installed)`);安装 = 用户显式动作 → planner/事务
  (`seedAssetTxFiles` + `populateFromCas` 接缝,REQ-103 接 UI)。
- **GC 互斥**:CAS 级锁 + 全环境 Bundle 锁(REQ-100 同一把)——活事务在场整轮跳过;
  崩溃恢复走既有 stale-lock 机;宽限窗防「刚提升未引用」误扫。

## 4. 已知边界(如实)

- GC 的生产触发时机(启动/定时/Hub 手动)未接线 —— 模块 + dry-run 可观测面已就位,编排归
  REQ-103(#195)。
- 项目 scope 安装的 generation 不参与 CAS mark(不可全局枚举);CAS blob 仅是缓存层,删除
  不破坏已物化安装,重装可按 digest 重取(合同 §2 导入面语义)。
- 顺带修复(必要相邻修理):`sync-catalog-snapshot.mjs`(REQ-105 既有)自 REQ-101-A 把公钥
  常量移居 catalog-channels.ts 后,其单源提取正则已抓不到别名常量(脚本在提钥处 die)——
  而本交付的互钉守卫要求 stable 晋级后两个快照**同步再生**,故将提取源改为
  `catalog-channels.ts` 的 `BUILTIN_CATALOG_PUBKEY_B64`(与 `sync-extension-seed.mjs` 同源);
  验证:`--from-file`(alpha-web checkout)重跑成功、catalog 字节零漂移。
- 真机(packaged app)验收待主会话统一补:见交付报告「真机验收探针」。
