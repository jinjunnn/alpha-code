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
| Which quality gate really runs in which environment (and where the environment is declared) | [`architecture/quality-gate-environments.md`](architecture/quality-gate-environments.md) |
| How many components a real Claude plugin becomes (measurement rule + distribution) | [`architecture/claude-plugin-corpus-component-scale.md`](architecture/claude-plugin-corpus-component-scale.md) |
| What the engine's `command` is, what its event/hook surface is, and how Claude's hooks actually map | [`architecture/engine-command-and-event-surface.md`](architecture/engine-command-and-event-surface.md) |
| Which signals really say a directory's model catalog converged (and which only look like they do) | [`architecture/2026-08-10-catalog-readiness-signals.md`](architecture/2026-08-10-catalog-readiness-signals.md) |
| Platform and endpoint integration                                    | [`contracts/`](contracts/)                                           |
| Session tool permission DTOs and decision receipts                   | [`contracts/session-permission.md`](contracts/session-permission.md) |
| Build, distribution, CI, uninstall, and Settings recovery operations | [`runbooks/`](runbooks/)                                             |
| Product and visual design assets                                     | [`design/README.md`](design/README.md)                               |
| Point-in-time audits and screenshots                                 | [`audits/README.md`](audits/README.md)                               |
| Focused verification records                                         | [`verification/`](verification/)                                     |
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
