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
