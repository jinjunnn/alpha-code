# Sprint 2026-07-05 S18 —— REQ-022~038 全量清扫批(除 034/035)

> **给接手的新 session**:用户 2026-07-05 拍板「继续处理 REQ-022~038,不执行 34/35;每个需求独立处理(一 REQ 一 PR);必要时 /codex:rescue 只审计不改码;必须完全处理完成」。开工前已按用户要求完成两件事:① 待拍板项一次性问清(下方「拍板记录」,后续不再卡交互);② 需求间冲突检查(下方「冲突矩阵」)。
> 各任务验收真源 = 对应 `requirements/` 档。

## 目标
S17 清完思考债后,把 2026-07-05 立项的产品需求线(composer 收敛 / 创建技能化 / 上游治理 / 模型配置化 / failover / 远程 catalog / 开放安装面)与自动化余期(A2/A3+云 schedule)、小白文档一次性全量落地。跨 A/B/C 三仓,B 侧连带清 PA-27 三 P0 前置。

## 拍板记录(2026-07-05,用户批,后续实现直接引用不再问)
1. **REQ-037 默认模式 = denylist**(allowlist 可切,schema 两模式同表达)——确认档内建议。
2. **B+C 仓 prod 部署全授权**:gateway CF Worker(含 `EDITION_CONFIG` var)+ account ECS + alpha-web Vercel 均可直接部署;每步留验证证据(curl/日志);EDITION_CONFIG 上 var 前先确认运营者租户 id 生效再收口,避免自锁。运营者租户 = impharaon92@gmail.com 对应租户(从 account DB 查 id)。REQ-032 签名私钥:生成后存 Vercel env + 本地 gitignored 备份并留档。
3. **REQ-022 连带清 B 侧前置**:PA-27 三 P0(AR-1/2/3 计费正确性)→ PA-28(cron trigger + schedule registry + dispatch)→ REQ-022 契约端点 → REQ-025 A 侧。B16 仅门控公开放量,dev 自用先行。
4. **REQ-026 落点 = alpha-web(C 仓)**;app 内「帮助」菜单加一条链接指过去(一行,不算双落点)。

## 冲突检查矩阵(用户要求,2026-07-05;结论:**无互斥冲突**,10 处交叉干涉面全部以「顺序 + 设计微调」消解)

| # | 干涉面 | 消解 |
|---|---|---|
| X1 | REQ-036 出厂注入 skill-creator × catalog 仍有 `skill:skill-creator` 可安装条目(双重身份,已装/可装态混乱) | hub 对 factory 注入技能显示「出厂内置」态、不显安装按钮;catalog 条目保留(供 `ALPHA_FACTORY_SKILLS_DISABLE` 用户手动装) |
| X2 | REQ-037 治理 disable/hide × alpha 注入 agent(alpha-automation / REQ-028 readonly / REQ-024 standard)——禁掉即自动化/只读档静默失效 | 保护名单在上游 compaction/title/summary 之外**纳入全部 alpha 注入 agent**(UI 灰显+原因);env 注入与 home jsonc 的 merge 优先级实现期实证 |
| X3 | REQ-030 × REQ-031 同一 models.config.json,分两次定 schema = churn | schema v1 即含 `routes[]`(单 route = 长度 1 数组),REQ-030/031 相邻实现一次定型 |
| X4 | REQ-031 ledger `upstream` 字段 × PA-27 计费 P0 同改 settle 路径 | B 侧顺序固定:PA-27 P0 → REQ-030/031(ledger 变更一次做)→ PA-28/REQ-022 |
| X5 | REQ-029 variants 定义 × REQ-030 策展(旧代模型删除)/ 新 routing 代码 | REQ-029 排 REQ-030/031 之后;variants 只对策展后清单定义;透传核实对新代码做 |
| X6 | REQ-038 × REQ-028/029 同文件 `composer-controls.tsx` | REQ-038 先落(共享层定型),028/029 基于收敛后层实现;038 不动 chip 语义(档内非目标) |
| X7 | REQ-032 条目级更新角标 × REQ-033 `origin:custom/imported` receipts | 更新判定按 receipts.origin 过滤,非 catalog 来源不参与角标(防误报) |
| X8 | REQ-036 删表单+tab 更名 × REQ-033 同 tab 加 MCP 手动添加/agent 导入 | 顺序 036 → 033;tab 语义「导入」,036 实现时留挂点 |
| X9 | REQ-036 `alpha_reload` 会话流中调 dispose × 「dispose 打断活跃流」既有真机残单 | 实现期实测;若打断则改两段式(标记待重载,流结束后 main 执行 dispose) |
| X10 | REQ-024 本地连败熔断 × REQ-022 B 侧熔断,语义须一致 | 同一口径(连败 3 次、恢复方式)先在 REQ-024 定,REQ-022 对齐 |

无干涉:REQ-026(纯文档)、REQ-025(纯接 REQ-022 契约)、REQ-030 edition 收口。

## 执行顺序(拓扑排序,一 REQ 一 PR)
- **A 线**:REQ-038(P0 bug)→ REQ-036 → REQ-037 → REQ-033 → REQ-024 → REQ-028
- **B 线**:PA-27 三 P0 → REQ-030(+A 侧 snapshot 刷新)→ REQ-031 → REQ-029(B 透传核实+A 侧)→ PA-28 → REQ-022
- **C 线**:REQ-032(C 端点 → A 接入)→ REQ-026(文档)
- **收尾**:REQ-025(A 侧云档位,前置 REQ-022 批内解除)
- A/B/C 线可交错;线内顺序不可倒(X3–X6、X8 依赖)。

## Task 表

| Task | REQ | 仓 | 状态 |
|---|---|---|---|
| T1 | REQ-038 composer 收敛(首页 `/` 菜单 P0) | A | ☑ PR #98(slash/@/IME/外壳单源/裁切根因修复;[audits/s18-t1](../../audits/2026-07-05-s18-t1-req038/verify.md)) |
| T2 | REQ-036 创建技能化 | A | ☐ |
| T3 | REQ-037 上游治理层 | A | ☐ |
| T4 | REQ-033 开放安装面 | A | ☐ |
| T5 | REQ-030 模型配置化 + edition 收口 | B(+A 核验) | ☐ |
| T6 | REQ-031 gateway failover | B | ☐ |
| T7 | REQ-029 effort=variants | X | ☐ |
| T8 | REQ-024 自动化 A2 | A | ☐ |
| T9 | REQ-028 真只读档 | A | ☐ |
| T10 | REQ-032 远程 catalog | X(C+A) | ☐ |
| T11 | REQ-026 小白文档 | C | ☐ |
| T12 | PA-27 P0 + PA-28 + REQ-022 云 schedule | B | ☐ |
| T13 | REQ-025 自动化 A3 | A | ☐ |

## Gates
- **一 REQ 一 PR**(用户指令);每 PR 按 ADR-018 四件套回写(BACKLOG 翻状态 + 本表勾选 + CHANGELOG + 需求档 frontmatter);
- **codex 审计不改码**:实现后必要时 /codex:rescue 审计,发现项由本 session 修;
- 北极星:A 仓零改上游(guard 绿);B/C 仓部署每步留证据;
- UI 触点 [[visual-verify-required]]:CDP 截图才翻 verified;做不到的如实残单入真机批;
- 拍板项已前置问清(上方),实现期不再问;撞到**新的**未决项 → 按档内建议执行并高亮记录,不卡。

## 结果(收尾回填)
_进行中。_
