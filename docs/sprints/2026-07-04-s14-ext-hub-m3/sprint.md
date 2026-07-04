# Sprint 2026-07-04 S14 —— 定制中心 v3-M3:云能力进 hub + ADR-021 §2 三校验落地(REQ-020)

> **给接手的新 session**:这是定制中心 v3 的第 3 阶段(M1 账本/桥/dispose、M2 详情页/更新/导入均已 shipped,PR #66–#79)。开工先读三份:
> ① 验收真源 [requirements/REQ-020](../../requirements/REQ-020-ext-hub-cloud.md) · ② 方案 §6 [designs/2026-07-04-extension-hub-v3-universal.md](../../designs/2026-07-04-extension-hub-v3-universal.md) · ③ 数据边界 [ADR-021](../../../.claude/rules/adrs/ADR-021-cloud-data-boundary.md)(§2 即本 sprint T1)。
> **别重做**:cloud jobs HTTP/IPC/SSE/saveRun 链路已 shipped(S11,`alpha-cloud-jobs.ts`/`cloud-ipc.ts`/`cloud-run-watcher.tsx`);mcp.cloud 注入在 `sidecar.ts`(platform 登录态才点亮);hub 的 cloud tab 已有占位(M2 T1)。M3 = 把云装进 hub + 把 ADR-021 §2 从「待实现」变实现。

## 目标
云对定制中心不再不可见:cloud tab 从占位变真内容(登录门控 + 连接器详情 + pipeline 条目),同时补上 dispatch 上行的三项硬校验(1MB 帽 / secrets 拒发 / denied_paths 缺省注入)——它是 REQ-021 A3 / REQ-022 云档自动化的硬前置。

## 抽取
REQ-020(T1–T4;**T5 远程 catalog 不抽**——门 = C 仓端点未建,留 BACKLOG)。

## Task 表

| Task | 内容 | 对应 | 状态 |
|---|---|---|---|
| T1 | **ADR-021 §2 三校验**:`dispatchCloudJob` 前置纯函数 guard(`cloud-envelope-guard.ts`)——denied_paths 缺省注入(`.env* / *.pem / .alpha/ / .git/`)→ 序列化 >1MB 拒发(loud,不截断)→ input/objective secrets 模式扫描(命中拒发 + 指出字段,不静默改写);单测覆盖三路径;ADR-021「⚠️ 待实现」翻 ✅ | REQ-020 T1(兼 B3 验收⑦) | ☑ |
| T2 | **云分区 + 登录门控**:cloud tab 真内容;未登录/BYOK → 灰显 + 诚实说明 + 登录 CTA(`window.api.auth.start`);platform → mcp.status.cloud 点亮 | REQ-020 T2 | ☑ |
| T3 | **cloud 连接器详情页**:新 DetailTarget `cloud-connector`;4 工具(cloud_dispatch/status/await/artifacts)+ 数据边界(diff-only 优先/1MB 帽/denied_paths/secrets 扫描,引 ADR-021)+ 实时连接状态;如实说明「登录 platform 模式自动注入,非安装项」 | REQ-020 T3 | ☑ |
| T4 | **云 pipeline 条目**:catalog 新类型 `cloud`(research/code-review/docs);详情 = 输入契约(B `pipelines.ts` 实测形状)/预算默认 25 iter·300k tok·600s 与上限 50·500k·1800(B clamp)/Tier/上行数据明细;「启用」= receipts-only(`ext-enable-cloud` IPC,不写引擎 config);code-review 详情带 diff-only dispatch 入口(选目录 → main `git diff` → dispatch → SSE 进度 → 终态 saveRun 落 `.alpha/runs/`) | REQ-020 T4 | ☑ |
| T5 | **验收**:单测三路径绿;typecheck/alpha-check 绿;CDP 截图 BYOK 灰显态([[visual-verify-required]]);四件套回写(BACKLOG/CHANGELOG/REQ-020 frontmatter/本表) | REQ-020 验收①②④ | ☑(①单测部分;真发/双态/端到端见下) |

## Gates
- 上游源码零改(北极星);后端仅走既有 IPC/SDK 接缝;新 IPC(ext-enable-cloud / cloud-git-diff)守 ADR-014 §8 校验纪律。
- 失败一律行内(B11);灰显态文案诚实(不装「即将可用」,说清为什么灰、怎么点亮)。

## 真机批(递延,并入 REQ-016 场次)
- 验收①后半:登录态**真发**一次超限/含密钥样本 dispatch,确认 B 侧此前从未收到(A 挡住);
- 验收②:BYOK 灰显 + platform 点亮 **双态截图**(platform 态需登录);
- 验收③:code-review 从 hub 端到端(dispatch → 进度 → artifact 回流 `.alpha/runs/`,兼 B3 verified 项)。
