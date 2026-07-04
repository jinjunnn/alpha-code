# Sprint 2026-07-03 S11 —— 云闭环 + 呈现底座 + 安全纵深 + 破坏面收敛

**目标**:一批推进 4 条高复杂度线:G4 云协同 in-app 最后一公里、静默失败清零底座(launch-blocker #6)、Electron 纵深防御、升级破坏面收敛(ADR-016 待办①)。
**抽取**:B3、REQ-004、C9 · B11、B20、B23 · C24、C27、C25 · C14(BACKLOG 已翻 in-sprint);B5 尾项(崩溃自愈)顺带记账(行保持 shipped)。
**批准**:用户 2026-07-03「就按照你刚才的几个」(四线全批);**G4 优先级拍板 = 接受**(G4 抬为 headline,REQ-008 对应子项划记,结论已写入需求档)。
**不抽**:REQ-016 真机 4 项(用户已定后续做)、A2 存量迁移(A6 R3 门控未解除)。

## Task 表(模型档位按 PROCESS §4 风险×模糊度)

| Task | 内容 | 对应 ID | 模型 | 状态 |
|---|---|---|---|---|
| **Track A —— 云线闭环(G4,headline)** | | | | |
| T1 | `.alpha` 桥接三法实测(config 注入 / symlink 发现 / 双写)出 verdict + ADR-019 回填(schema/gitignore/桥接选型) | REQ-004 | fable | ✅ PR #54(verdict:①②双 CONFIRMED,③不启用;证据 [audits/req004-spike](../../audits/2026-07-03-req004-alpha-bridge-spike.md)) |
| T2 | B3 in-app 闭环:登录态 agent 经 cloud MCP dispatch → 会话内流式进度 → 结构化结果回流;artifact 落 `.alpha/`(依 T1);失败会话内重试 + dispatch 前配额可见(呈现面与 T4 对齐) | B3 | fable | ◐ 半程 PR #55(主进程回流链路:alpha-workdir + cloud-save-run IPC + preload;剩 renderer 接线/配额 UI/in-app 冒烟) |
| T3 | C9 代码上云数据边界 mini-ADR:diff-only / secrets 过滤 / consent / 体积上限(与 T2 同场) | C9 | fable | ✅ PR #56 = ADR-021(双通道边界 + B16 挂钩;§2 待实现项随 B3 记账) |
| **Track B —— 呈现底座(launch-blocker #6)** | | | | |
| T4 | B11 统一错误/健康呈现面 + 账户 banner:store.error 全渲染、统一 toast/错误体系一处定义、32 失败点复扫 ≥90% 有反馈;收编 B20 弱网降级 UX + B23 配置清零显式告警 | B11 / B20 / B23 | opus 实现 · fable 审 | ☐ |
| T5 | B5 尾项:sidecar 崩溃自愈(REQ-003 终态判定已收,解锁) | B5(尾项) | opus | ☐ |
| **Track C —— 安全纵深** | | | | |
| T6 | C24:先撤 `ACAO:*` 注入(windows.ts)→ renderer CSP 落地(connect-src 收敛)→ 隔离 dev + 打包双态逐屏走查 + exfil 拦截取证;**断 renderer 即回退** | C24 | fable | ☐ |
| T7 | C27 + C25:fuses(关 RunAsNode,先评估 utilityProcess/sidecar 依赖)+ asar-integrity + entitlements 逐项收紧;`open-path`/`ext-install-plugin` exec 触达面收紧;打包签名+公证复验(stapler/spctl)+ DISTRIBUTION.md 记账 | C27 / C25 | fable | ☐ |
| **Track D —— 破坏面收敛** | | | | |
| T8 | C14:借用内部 provider 收敛为 `alpha-ui/providers/*` 薄 re-export(一处断)+ 高频选择器 `data-alpha-*` 重打点(载体 = REQ-012 `upstream-anchors.json`);16 处 `as any` 清点收敛 | C14 | fable | ☐ |

## 依赖与排序

- **T1 → T2**:B3 验收⑤(artifact 落 `.alpha/`)依赖 REQ-004 桥接 verdict;T1 先行。
- **T6 内序**:撤 ACAO 先行(独立可回退),CSP 后上;T6/T7 共享同一次打包回归场,合并收口。
- **四 track 互不撞文件**,可按 S9 先例并发 session 分派;单 session 则按 A → B → C → D。
- PR 粒度(PROCESS §4):每 task ≈1 个短命 PR;T6/T7 可合为安全批 1–2 个 PR;T4 可拆「底座」/「复扫收尾」两个 PR。

## Gates(每个实现 PR)

typecheck ☐ · bun test ☐ · 北极星守卫 ☐ · /app:review ☐ · visual-verify(UI 变更 CDP 截图)☐
Track C 附加:打包双态全功能走查 ☐ · stapler validate / spctl 复验 ☐

## 拍板提醒(执行中撞到必停,不代替决策)

- **B16 PIPL 维持 parked**:本批 B3 仅自用 in-app 闭环、不公开分发,不触发重启条件;公开发布前必须重启(R7:登录默认 platform-pays = 持续出境)。
- C24 有断 renderer 前科告诫(册 §7g):任一屏回归失败即回退,不带病合入。
- REQ-004 spike 只验证 + 回填 ADR-019 修订,**不回摆主决策**(全部进 `.alpha/`,ADR-019 §3 降级路径逐类记录)。

## 结果(收尾时填)

_待填。_

## 回写清单

BACKLOG ☐ · CHANGELOG ☐ · 需求档 frontmatter ☐ · verify 记录 ☐ · retro 链接:—
