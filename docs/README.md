# alpha-code documents

<!-- documentation-contract: v3 -->

Active work is owned only by [alpha-code Issues](https://github.com/jinjunnn/alpha-code/issues)
and [Alpha Delivery](https://github.com/users/jinjunnn/projects/2). Current
runtime behavior comes from code, tests, schemas, packaged resources, and
accepted contracts. Follow the [Alpha Documentation Contract](https://github.com/jinjunnn/alpha-work/blob/main/governance/documentation-standard.md).

| Need                                                                 | Canonical source                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| System structure and upstream boundary                               | [`architecture/`](architecture/)                                     |
| Host extension package contract/host decision boundary               | [`architecture/host-extension-package-contract-boundary.md`](architecture/host-extension-package-contract-boundary.md) |
| Alpha Connection record lifetime and handler allowlist               | [`architecture/alpha-connection-lifetime.md`](architecture/alpha-connection-lifetime.md) |
| Package MCP OAuth ownership boundary (engine protocol / main attempt) | [`architecture/package-mcp-oauth-boundary.md`](architecture/package-mcp-oauth-boundary.md) |
| Which quality gate really runs in which environment (and where the environment is declared) | [`architecture/quality-gate-environments.md`](architecture/quality-gate-environments.md) |
| How many components a real Claude plugin becomes (measurement rule + distribution) | [`architecture/claude-plugin-corpus-component-scale.md`](architecture/claude-plugin-corpus-component-scale.md) |
| What the engine's `command` is, what its event/hook surface is, and how Claude's hooks actually map | [`architecture/engine-command-and-event-surface.md`](architecture/engine-command-and-event-surface.md) |
| Which signals really say a directory's model catalog converged (and which only look like they do) | [`architecture/2026-08-10-catalog-readiness-signals.md`](architecture/2026-08-10-catalog-readiness-signals.md) |
| What the packaged first launch actually spends after sidecar ready (measured split, and what is still unverified) | [`architecture/2026-08-10-packaged-first-launch-catalog-cost.md`](architecture/2026-08-10-packaged-first-launch-catalog-cost.md) |
| Which layer can actually contain tool-spawned processes, and which candidate seams cost an upstream adoption | [`architecture/2026-08-23-shell-sandbox-seam.md`](architecture/2026-08-23-shell-sandbox-seam.md) |
| How long the two outbound fetch chains in `packages/core` can actually block, and which shipped shapes never reach them | [`architecture/2026-08-23-network-timeout-recon.md`](architecture/2026-08-23-network-timeout-recon.md) |
| Platform and endpoint integration                                    | [`contracts/`](contracts/)                                           |
| Session tool permission DTOs and decision receipts                   | [`contracts/session-permission.md`](contracts/session-permission.md) |
| REQ-131 分层工具策略:三态/四类/selector、cap 合成、binding guard、分区持久化与 V1 session grant 语义 | [`contracts/tool-policy.md`](contracts/tool-policy.md)               |
| Build, distribution, CI, uninstall, and Settings recovery operations | [`runbooks/`](runbooks/)                                             |
| Product and visual design assets                                     | [`design/README.md`](design/README.md)                               |
| Point-in-time audits and screenshots                                 | [`audits/README.md`](audits/README.md)                               |
| Focused verification records                                         | [`verification/`](verification/)                                     |
| REQ-128 桌面端对公网 stable 的 `package:alpha-first` 浏览/详情/安装取证(四条 AC 全 PASS;目录安装落 `disabled` 是既定策略) | [`verification/2026-08-26-req128-163-desktop-live-package/README.md`](verification/2026-08-26-req128-163-desktop-live-package/README.md) |
| REQ-138 AC4 #1076 打包 Electron sidecar 上的沙箱正反语料(围栏 ON 7/7 不落盘、围栏移除的打包副本 7/7 落盘;会写盘的 rc 静默失效但不中断命令) | [`verification/2026-08-26-req138-1076-packaged-sandbox/README.md`](verification/2026-08-26-req138-1076-packaged-sandbox/README.md) |
| REQ-131 #725 工具策略双咽喉矩阵(模型目录闸真绿;执行咽喉只对 MCP 成立 —— builtin/plugin/host 的 `ask` 不问、`deny` 照跑;`always` 跨会话且压得过后来的 `deny`) | [`verification/2026-08-25-req131-725-tool-policy-chokepoints/README.md`](verification/2026-08-25-req131-725-tool-policy-chokepoints/README.md) |
| REQ-092 #402 descriptor-only 有界产物传输七格矩阵(格 4/6/7 PASS;格 1/3/5 部分 FAIL;格 2 摘要 PASS、峰值 RSS 超顶) | [`verification/2026-08-25-req092-402-artifact-transfer/README.md`](verification/2026-08-25-req092-402-artifact-transfer/README.md) |
| REQ-109 startup P95 after #1098/#1099 (FAIL 8,313ms; the tail is now named: first project-list fetch) | [`verification/2026-08-24-req109-p95-post1098-1099/README.md`](verification/2026-08-24-req109-p95-post1098-1099/README.md) |
| REQ-109 packaged 稳态 catalog P95 after #1083 (FAIL: merged P95 5,347.1ms; new 5s-liveness + uninstrumented mount window) | [`verification/2026-08-24-req109-p95-post1083/README.md`](verification/2026-08-24-req109-p95-post1083/README.md) |
| Lessons and retrospectives                                           | [`retrospectives/`](retrospectives/)                                 |
| User-visible shipped changes                                         | [`../CHANGELOG.md`](../CHANGELOG.md)                                 |
| Retired developer prose                                              | [`archive/DEPRECATED.md`](archive/DEPRECATED.md)                     |

Runtime-loaded decisions remain in the protected `.claude/rules/adrs/`
namespace. They are rule/decision assets and are not copied into docs. The old
backlog, requirements, plans, Sprints, process handbook, and implementation
plans were removed after their valid conclusions and delivery identities were
promoted. Do not recreate role aliases, `latest`, `done`, or local work-state
trackers.

Within `architecture/`, `overview.md` and `upstream-integration.md` are current
authority. `understanding.md`, `extension-seams.md`, and the diagram corpus are
protected point-in-time cartography/knowledge assets; use them for provenance,
not for current package versions, synchronization rules, or implementation
status.
