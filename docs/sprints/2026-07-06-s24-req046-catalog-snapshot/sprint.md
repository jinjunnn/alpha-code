# Sprint 2026-07-06 S24 —— REQ-046 catalog 作者真源收敛(快照 + 守卫 + agent 远程接线)

> **抽取(2026-07-06,S23 收批后用户拍板开工)**:REQ-046(ready,P1 debt)。用户目标:「新增 agent/skill/mcp/plugin 不再发版 alpha-code」;拍板 = C 仓 catalog-src 唯一作者真源,A 仓只留必须硬编码之物。用户追问「plugin 例外还是全部例外、只走发包?」→ 裁决:**四类全部零发版;plugin 只是通道例外**(可执行 JS 本体走 npm 发包,条目仍走 C;不走 C 文本资产通道)。WIP=1 满足(S23 已收尾,PR #120/#121)。
> **纪律**:零改上游;快照必须验签(逃生 --from-file 也不逃验签);守卫红绿演练必须留证;agent 远程接线沿 codex H1 信任边界(renderer 只传 catalogId)。

## Task 表

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T1 | 快照脚本 `ui-mac/scripts/sync-catalog-snapshot.mjs`:fetch 已发布 catalog+.sig → ed25519 验签(公钥单源自 remote-catalog.ts,不复制常量)→ 形状 sanity → 版本单调拒回退 → **字节原样**写 alpha-catalog.json + meta(alpha-catalog.snapshot.json) | 对 prod 端点实跑成功;逃生 --from-file 同验签 | ✅(实跑:2026-07-06.1,23 entries) |
| T2 | 守卫:alpha-catalog.test.ts 快照断言(文件 sha256 == meta,version/entries 数一致)—— 手编即红 | 红绿演练:手编一字节 → 红;脚本刷新 → 绿 | ✅(演练留痕本批日志) |
| T3 | agent 远程通道接线(补齐零发版最后一类):AgentInstallSpec source +remote;`installRemoteAgent`(单 .md 约定/256KB 帽/writeAgent 同管线 origin=catalog);IPC `ext-install-remote-agent`(main 从已验签 catalog 派生);preload/types;renderer installAgentEntry 分流 | +5 单测(happy/非法名/多文件/嵌套路径/超帽);typecheck 绿 | ✅ |
| T4 | ADR-023 修订(作者真源收敛 + 四类通道表 + 「仍需发版」清单)+ DISTRIBUTION 发版步骤 ①′ + C 侧 catalog-publish.md 同步 | 文档与实现一致;plugin 裁决入档 | ✅(C 侧随 alpha-web PR #8) |
| T5 | 回写:BACKLOG REQ-046 翻 shipped(+PR)· 需求档 frontmatter · CHANGELOG · sprint 契约 | 四件套齐 | ✅(PR #122) |

## Gates
- `scripts/alpha-check.sh` 全绿;alpha-ci 四关随 PR;
- 真机递延:远程 agent 端到端(C 上架一条测试 agent → hub 安装 → 会话可用)→ 下一真机批(联动 REQ-045 补货时一并演练最顺)。

## 明确不做
- 不做 C 侧 plugin 资产托管(ADR-023 phase 2,逐包签名前置,不抢跑);
- 不改运行时回退链语义(远端→缓存→内置,REQ-032 已验收);
- 不为 snapshot 加自动化 cron(发版时刷新即可,YAGNI)。

## 结果(2026-07-06 回填)

**REQ-046 全落(A 侧 PR #122 + C 侧 alpha-web PR #8)= shipped**:
- 快照链:脚本实跑 prod 端点(验签过,2026-07-06.1/23 entries 字节原样落盘)+ meta;守卫红绿演练 PASS(手编「钉钉」→「钉钉X」一字节 → 守卫红;脚本刷新 → 绿)。
- agent 远程通道:接线全链(类型/installer/IPC/preload/renderer),+5 单测(36 installer 测试全绿);「新增条目零发版」自此对 mcp/skill/agent/plugin(经 npm)+command(不单列)全部成立。
- 文档:ADR-023 修订(含四类通道表 + 仍需发版三情形:vendored 资产更新/公钥更换/schema 演进)+ DISTRIBUTION ①′ + C 侧 catalog-publish.md。
- gates:北极星守卫 ✓ typecheck ✓ 单测全绿。

**verified 门(真机递延)**:C 上架远程 agent → hub 安装 → 会话可用(联动 REQ-045 补货演练)→ 下一真机批。
