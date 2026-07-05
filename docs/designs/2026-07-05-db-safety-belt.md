# DB 安全带(C17 版本预检 + B14 备份/导出)— mini 设计

> S17 T3,2026-07-05。全部落 alpha 自有文件(ui-mac main),零改上游(ADR-005);引擎/DB 本体行为不动(R2)。
> 下方「事实」均为**当日实证**(代码内省 + 实机探针),非推断。

## 事实(实证)

| # | 事实 | 证据 |
|---|---|---|
| F1 | 水位 = DB 内 `migration` 表(`id TEXT PRIMARY KEY`),id = 迁移文件名(时间戳前缀,字典序即时序) | `core/src/database/migration.ts:30,46` |
| F2 | app 支持面 = `migration.gen.ts` import 清单 ≡ `core/src/database/migration/*.ts` 文件名(当日 38 条,与实机 prod DB 的 38 条一致,max id 相同) | `migration.gen.ts` + 实机 `SELECT COUNT(*)` |
| F3 | **`applyOnly` 不检查 DB 中未知 id** —— 旧 app × 新 DB 静默继续(C17 风险代码级确认);且遇纯旧库会从 `__drizzle_migrations` 播种 | `migration.ts:43-81` |
| F4 | prod/beta/latest channel → DB = `<data>/opencode.db`(实机确认,今日活跃);其它 channel 带后缀(dev 分支库 = D9 来源);`OPENCODE_DB` env 可覆盖(test 模式 `:memory:`,`index.ts:183`);data = `$XDG_DATA_HOME \|\| ~/.local/share` + `/opencode` | `database.ts:path()` + 实机 `ls` |
| F5 | DB 跑 WAL(`journal_mode=WAL`,实机 -wal/-shm 在盘) | `database.ts` PRAGMA + 实机 |
| F6 | `/usr/bin/sqlite3 -readonly` 可读活库水位(exit 0);损坏签名 = exit 26 + `file is not a database` | 实机探针 |
| F7 | **备份唯一可靠形态 = readonly 会话 `VACUUM INTO`**(integrity ok、水位可读、压实 7.3M→3.8M、源库零写);`-readonly` 下 `.backup` **exit 0 但不写文件**(静默假成功),rw `.backup` 产物 readonly 打不开(WAL 遗留) | 实机探针 A/B 对比 |

## 决策

1. **守卫范围 = 打包态 only**(`app.isPackaged`):dev 跑分支后缀库、channel 解析是构建期常量,dev 下守错目标的风险 > 收益;dev 启动仅 log 一行 skip。菜单动作在 dev 置灰(同理,防备错库)。
2. **app 支持面清单 = 构建期生成 JSON**(`resources/db-expected-migrations.json`,`{v:1, ids:[...]}`):prebuild 新步骤从 `core/src/database/migration/*.ts` 文件名派生 → extraResources 进包 → 运行时 `process.resourcesPath` 读。**不运行时 import core**(ARCHITECTURE 硬约束②);文件 gitignore(构建产物,打包链路必新鲜)。
3. **预检时序**:main 初次 spawn sidecar **之前**(index.ts spawn Effect 内、`spawnLocalServer` 前);respawn 路径**不**重跑(启动时已验,运行中水位不会倒退)。正常路径开销 ≈ 1 次 sqlite3 exec(实测 ~10ms)。
4. **判定与动作**(`unknown = db − app`,`pending = app − db`):
   - 文件不存在 / `:memory:` / dev / 清单缺失 / sqlite3 缺失 / 其它读错 → **fail-open**:跳过 + loud log(守卫绝不把启动搞得更糟);
   - `unknown ≠ ∅` → **DB 超前,阻断对话框**(C17①):〔退出(推荐,请升级 app)/ 备份后继续 / 直接继续〕——不静默继续,继续权显式交用户;
   - `pending ≠ ∅`(含 legacy 无 `migration` 表)→ 引擎本次启动**将要**前进迁移 → **自动 pre-migration 备份**(降级逃生快照,B14① 自动触发);备份失败 → 警示对话框〔继续 / 退出〕(反 B11 不静默);
   - 相等 → 直接放行(常态)。
   - 损坏(F6 签名)→ **恢复对话框**(B14③):〔从最近备份恢复 / 仍要启动 / 退出〕;恢复 = 损坏件改名留存(`.corrupt-<ts>`)+ **连带清掉旧 -wal/-shm**(防污染恢复件)+ 最新已验证备份复制回位。
5. **备份引擎**:`sqlite3 -readonly <src> "VACUUM INTO '<tmp>'"` → **必验**(readonly `integrity_check` == ok 且 `migration` 可读)→ rename 落名 `opencode-backup-<YYYYMMDD-HHmmss>.db` → 滚动保留 **5** 份(常量);**验不过 = 删产物 + loud log**(F7 教训:无验证的备份 = placebo)。落点 `<userData>/alpha-db-backups/`(alpha 域,不进 opencode 数据目录)。
6. **手动入口 = 应用菜单「数据」**(main 自有 menu.ts 追加,零 renderer 风险):立即备份 / 导出…(save dialog + VACUUM INTO + 验证)/ 打开备份文件夹。文案中文硬编码(main 无 i18n,ADR-022 先例)。**B14④「与 C16/C17 同屏」的设置页入口随 C16(S17 stretch)落**,本批不做 renderer UI。
7. **路径镜像的耦合诚实声明**:`resolveDbPath` 镜像上游 `database.ts:path()` 12 行逻辑(契约锚注释互指);上游改路径规则 → 守卫 fail-open(文件不存在 → skip + log),**不会**误伤启动;sync 后由锚点注释提醒复核。

## 非目标
结构化会话导出(JSON/markdown,B14② 后续)· in-DB 修复/重建(上游域)· 定时周期备份(pre-migration 触发已覆盖最高价值时点,YAGNI)· dev 态守卫 · renderer 设置 UI(→ C16)。

## 测试计划
纯逻辑(mock exec/fs):水位 diff 双向 / 路径镜像(env 覆盖·XDG·:memory:)/ 备份文件名与轮转(保 5 删旧)/ 恢复候选 = 最新已验证 / 损坏签名解析 / fail-open 各分支。
**真 sqlite3 集成**(`Bun.which("sqlite3")` skipIf):fixture 库构造「未来迁移 id」→ db-ahead 判定;VACUUM INTO 备份→验证→恢复往返;损坏文件 exit 26。
真机(残单 → 下个真机批):打包态改造 DB 植入未来 id → 启动见阻断对话框;损坏库 → 恢复流。
