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
| 为什么 Chromium 内置 PDF viewer 在隔离 session 里画不出页面(两条独立成因,都不报错) | [`architecture/2026-09-03-electron-pdf-viewer-session.md`](architecture/2026-09-03-electron-pdf-viewer-session.md) |
| 第三方 Office 渲染库放在哪里跑,为此放宽了什么(以及负向控制证明没削弱 HTML 那条路) | [`architecture/2026-09-03-office-layout-isolation.md`](architecture/2026-09-03-office-layout-isolation.md) |
| 外部技能目录(`~/.claude/skills` 等)为什么维持关闭:那行 flag 是 ADR-024 的安全裁决、同意门三条入口已上线且在本机弹过四次、打开会裸露的七类面逐一对照导入门 | [`architecture/2026-09-06-external-skills-inheritance-decision.md`](architecture/2026-09-06-external-skills-inheritance-decision.md) |
| 推理档位(`variant`)谁设得了、设错了会不会被告知:`--variant` 是上游 CLI 的表面而 alpha 不发 CLI(五项实读);产品侧的对应表面是 composer 档位 chip,它的「不支持」态此前零判据而 12 个平台模型里 10 个没有档位;§5 智谱直连对 `thinking.type` 的真实受理(`disabled` 真关、写错静默忽略且仍 200) | [`architecture/2026-09-06-model-variant-reachability.md`](architecture/2026-09-06-model-variant-reachability.md) |
| 托管层规则与「失败即中止」今天已经在跑在哪(managed cap + 执行咽喉),真缺口是引擎侧没有租户身份;托管 hook 暂不做的理由、重开条件与要补的账 | [`architecture/2026-09-08-managed-policy-and-hook-abort-decision.md`](architecture/2026-09-08-managed-policy-and-hook-abort-decision.md) |
| openai/codex 与本仓 harness 的逐层对照:为什么不能换底座(四个阻断)、codex 明确更强的四项、可吸收机制各自的归属票,以及 2026-08-23 之后已被推翻的事实(自我订正区) | [`architecture/2026-08-23-codex-harness-comparison.md`](architecture/2026-08-23-codex-harness-comparison.md) |
| 引擎到底从哪些地方派生出会落盘的进程(四类创建原语的实跑枚举):MCP stdio / LSP / PTY **都不经** `ChildProcessSpawner`(C3 覆盖面为零);PTY 缺省读 `cfg.shell` 故已被 REQ-138 罩住,而 `pty.create({command})` 与 `POST /mcp` 的 `MCP.add` 各自绕开;逐条收编代价按 north-star 守卫实测定价。**§6(第二轮)**:seatbelt 由子进程继承 ⇒ 整进程围栏一次罩住全部通路且引擎照常工作,但 `utilityProcess.fork` 接不上 `sandbox-exec`、嵌套异策略 exit 71 零执行 ⇒ 与 REQ-138 那层互斥;出货 node-pty 在现行 profile 下起不来(缺 `/dev/ptmx`)。**§7(第三轮)**:alpha 自己在 sidecar 里的写入面枚举 —— 实跑落盘 13 条(全落在 `<alphaGlobalRoot>` / `<userDataPath>` / `<workspace>/.code-puppy` 三个根),**随工作区变化的路径全在 `<workspace>/` 这一条前缀之下**;单一权威从**出货 bundle** 派生(70 条签名 / 85 个调用点,四臂含改名与新增两条反向臂);并更正 §3 表第 6 行 —— PTY 缺省**并未**被 REQ-138 罩住(插件改的 `cfg.shell` 与 `core` 的 `Config.entries()` 不是同一份) | [`architecture/2026-09-08-derived-process-spawn-paths.md`](architecture/2026-09-08-derived-process-spawn-paths.md) |
| Alpha 往模型上下文塞的字有哪几条通路、怎么证明枚举完备(从 `Hooks` 接口派生,不是清单)、每段多大、上限多少、超限怎么响亮失败;ui-mac `instructions` 与 `agent.*` 两条怎么跨包进同一份登记簿(零依赖内容模块 + 类型锁的能力形状域 + 真注入咽喉,agent 咽喉把 permission / mode 动词与字分开判) | [`architecture/2026-09-08-context-injection-registry.md`](architecture/2026-09-08-context-injection-registry.md) |
| Platform and endpoint integration                                    | [`contracts/`](contracts/)                                           |
| Session tool permission DTOs and decision receipts                   | [`contracts/session-permission.md`](contracts/session-permission.md) |
| REQ-131 分层工具策略:三态/四类/selector、cap 合成、binding guard、分区持久化与 V1 session grant 语义 | [`contracts/tool-policy.md`](contracts/tool-policy.md)               |
| Build, distribution, CI, uninstall, and Settings recovery operations | [`runbooks/`](runbooks/)                                             |
| Product and visual design assets                                     | [`design/README.md`](design/README.md)                               |
| Point-in-time audits and screenshots                                 | [`audits/README.md`](audits/README.md)                               |
| Focused verification records                                         | [`verification/`](verification/)                                     |
| REQ-128 桌面端对公网 stable 的 `package:alpha-first` 浏览/详情/安装取证(四条 AC 全 PASS;目录安装落 `disabled` 是既定策略) | [`verification/2026-08-26-req128-163-desktop-live-package/README.md`](verification/2026-08-26-req128-163-desktop-live-package/README.md) |
| REQ-138 AC4 #1076 打包 Electron sidecar 上的沙箱正反语料(围栏 ON 7/7 不落盘、围栏移除的打包副本 7/7 落盘;会写盘的 rc 静默失效但不中断命令) | [`verification/2026-08-26-req138-1076-packaged-sandbox/README.md`](verification/2026-08-26-req138-1076-packaged-sandbox/README.md) |
| #1144 打包产物里由 agent 回合驱动的 shell **工具**整链(围栏 ON 7/7 不落盘、反向臂 7/7 落盘),以及 Developer ID + hardened runtime 下的同一套语料(结论一致;真模型那一步仍未做) | [`verification/2026-08-26-req138-1144-packaged-shell-tool-chain/README.md`](verification/2026-08-26-req138-1144-packaged-shell-tool-chain/README.md) |
| #1144 `#1147` 合入之后打包产物里 shell 工具整链的复跑(围栏 14/14 不落盘、反向臂 14/14 落盘;负向控制证明这条链关得掉;真模型那一格仍未闭合) | [`verification/2026-08-26-req138-1144-postmerge-chain/README.md`](verification/2026-08-26-req138-1144-postmerge-chain/README.md) |
| #1144 AC1 打包产物里由**真模型**回合驱动的 shell 工具整链(围栏臂不落盘、反向臂落盘,`tool_calls` 原文入库;真模型 5 次里 3 次自己拒绝发这次越界调用) | [`verification/2026-08-27-req138-1144-real-model-chain/README.md`](verification/2026-08-27-req138-1144-real-model-chain/README.md) |
| REQ-131 #725 工具策略双咽喉矩阵(模型目录闸真绿;执行咽喉只对 MCP 成立 —— builtin/plugin/host 的 `ask` 不问、`deny` 照跑;`always` 跨会话且压得过后来的 `deny`) | [`verification/2026-08-25-req131-725-tool-policy-chokepoints/README.md`](verification/2026-08-25-req131-725-tool-policy-chokepoints/README.md) |
| REQ-092 #402 descriptor-only 有界产物传输七格矩阵(格 4/6/7 PASS;格 1/3/5 部分 FAIL;格 2 摘要 PASS、峰值 RSS 超顶) | [`verification/2026-08-25-req092-402-artifact-transfer/README.md`](verification/2026-08-25-req092-402-artifact-transfer/README.md) |
| REQ-109 startup P95 after #1098/#1099 (FAIL 8,313ms; the tail is now named: first project-list fetch) | [`verification/2026-08-24-req109-p95-post1098-1099/README.md`](verification/2026-08-24-req109-p95-post1098-1099/README.md) |
| REQ-109 packaged 稳态 catalog P95 after #1083 (FAIL: merged P95 5,347.1ms; new 5s-liveness + uninstrumented mount window) | [`verification/2026-08-24-req109-p95-post1083/README.md`](verification/2026-08-24-req109-p95-post1083/README.md) |
| `#1227` 右栏 PDF 叠放载体真 Chromium 取证(修复前非暗像素 0%/两个 frame;修复后 93.6%/三个 frame,分区目录关闭即收) | [`verification/2026-09-03-1227-rail-pdf-session/README.md`](verification/2026-09-03-1227-rail-pdf-session/README.md) |
| `#1229` 右栏 Office 版式载体真 Chromium 取证(docx/pptx/xlsx 三格全 PASS;抓到「自报渲染成功而画布只有外壳」与「仓内夹具不能判版式」两件事) | [`verification/2026-09-03-1229-office-layout/README.md`](verification/2026-09-03-1229-office-layout/README.md) |
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
