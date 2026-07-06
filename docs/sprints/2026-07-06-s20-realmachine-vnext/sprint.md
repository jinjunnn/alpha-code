# Sprint 2026-07-06 S20 —— 真机批 vNext(S16–S19 残单清账)

> **背景**:用户拍板抽取「真机批 vNext」。S16(REQ-016)清了主体,S17(深度决策)/S18(REQ 全量)/S19(静默失败)各自攒下真机递延;已装包为 v0.1.0(2026-07-04),**不含 S17–S19 全部代码** → 本批先从 alpha HEAD 重 ship 签名+公证包再走查(REQ-016 同法)。
> **方法**(沿用 REQ-016 §方法):prod 包 CDP = `ALPHA_CDP=1` + 直接二进制启动带 `--remote-debugging-port`;截图 `{fromSurface:true}`;日志取证 `~/Library/Application Support/ai.opencode.desktop/logs/<run>/main.log`;破坏性场景优先走 `OPENCODE_TEST_ONBOARDING=1` 隔离根或「备份→操作→还原」。
> 证据落 `docs/audits/2026-07-06-s20-realmachine-vnext/verify.md`。

## Task 矩阵

### P 组 —— 打包/安装前置
| # | 项 | 验收 | 状态 |
|---|---|---|---|
| P1 | 重 ship 签名+公证包(alpha HEAD,prod 渠道)| stapler validate + spctl accepted;resources/{agents,plugins}/skills/NOTICE 在包(兼 C5/B7② 复验)| ✅ |
| P2 | 装机 + 冷启动 healthy | 首屏正常;main.log 无新错类 | ✅(修污染态后;F-1 由此挖出)|

### M 组 —— 扩展生命周期残余(S12/S13)
| # | 项 | 验收 | 来源 | 状态 |
|---|---|---|---|---|
| M1 | 迁移开门演练 | `ALPHA_MIGRATE_ENABLE=1` + 旧位种子 → 迁 `~/.alpha` + 钉版重装 + 旧位净除 | A2 尾项 / REQ-016 B2 | ⏭ 归下批 |
| M2 | git 导入真克隆 | 公网小仓 https 浅克隆 happy-path 入账 | REQ-016 C3 | ⏭ 归下批 |
| M3 | 卸 uv 像素 | PATH 遮蔽 → 详情页「✗ 缺失 + brew 指引」截图 | REQ-016 C1 | ⏭ 归下批 |
| M4 | dispose 打断活跃流 | 流式中装/卸 → 行为定性记录 | REQ-016 C4 | ⏭ 归下批 |

### C 组 —— 云/引擎链路(登录态,视 token 存活)
| # | 项 | 验收 | 来源 | 状态 |
|---|---|---|---|---|
| C1 | saveRun 回流 | in-app dispatch → 终态 → `.alpha/runs/<runId>/` 落盘(兼 REQ-004 打包态冒烟)| B3 残余 | ⏭ 留用户批(耗额度)|
| C2 | B6 alpha_ping | 会话内 alpha_ping 进工具表且执行(G1 成功条件)| B6 残余 | ✅ G1 达成 |
| C3 | REQ-029 effort 真发 | 代理路 variant cycle → 真实请求携带 reasoning 参数(BYOK 视凭证可得性)| S18 残单 | ❌→F-2 已修(REQ-041)|

### B 组 —— 边界/崩溃/呈现(S17/S19 残单)
| # | 项 | 验收 | 来源 | 状态 |
|---|---|---|---|---|
| B1 | C28 打包态复验 | `__alphaCrashProbe` → 局部降级浮条截图 + app 存活 | S17 T4 | ✅ |
| B2 | C17/B14 对话框演练 | 构造超前 DB(隔离根)→ 阻断对话框实拍;「数据」菜单备份/导出实操 | S17 T3 | ⏭ 归下批 |
| B3 | B4 冷启动日志 + watcher | main.log:"/"+home 零 session.list;watcher 数与项目数一致 | S17 T5 | ✅ 数据层(深层断言留 netlog 专项)|
| B4 | banner 冷启动 | 故意写坏全局 jsonc(备份还原)→ configHealth warning banner 截图 | B11/B23 残余 | ✅ 未知键支 loud(F-3;语法错支残余)|
| B5 | REQ-014 打包态复现 | 毒 `tabs.recent` → 冷启动形态记录(供②修法实施)| S17 T4 顺带 / REQ-016 F | ⏭ 归下批 |
| B6 | B22 复现尝试 | 时间线崩溃复现步骤探索;复现即录,不修 | REQ-016 F | ⏭ 归下批 |
| B7 | S19 失败态实拍 | 杀 sidecar → rename/delete/新建会话失败 toast(T1/T5);伪深链 ×2 code → 登录失败 toast(T6);连崩×6 → banner → 重试恢复(T7 打包态)| S19 残单 | ⏭ 用户批 |
| B8 | C3 日志运行期轮转 | 膨胀 opencode.log>25MB → 重启触发归档留 3 份 | REQ-016 F | ⏭ 归下批 |

### 留用户批(agent 不可代办,如实列)
- B2 短 TTL 全路径(改 prod alpha-web env,侵入)· logout→重登(浏览器 OAuth)· 真断网 vendored 走查 · 真睡眠错过 · REQ-030 运营者 intl picker 自验 · B9 更新链(需下个真实发版)。

## Gates
- 破坏性操作先备份后操作,做完立即还原并复验(DB/全局 jsonc/store);
- 每项证据(截图/日志行/文件路径)入 audit 文档才翻状态;
- 完成回写:对应 ID 翻 verified(A2/B3/B6/B4/C17/B14/C28/C3…);B11 视觉批范围内项随证据翻;S13 acceptance 清单对账。

## 结果(2026-07-06 回填)
- **重 ship 签名+公证包(alpha HEAD)装机走查**,跑 8 项:✅ verified 6(P1 签名公证+资产 · P2 冷启动 · B1 C28 崩溃边界打包态 · B3 B4 巨型目录数据层 · C2 B6 alpha_ping G1 真执行 · B4 B23 未知键 loud 呈现)。
- **挖到并修复 2 个真机 bug**(真机批核心价值):
  - **F-1 → REQ-040**:冷启动陈旧 `defaultServerUrl`(具体端口)无存活校验 → 连死端口卡「无法连接到 Local Server」。修=`isEphemeralLocalServerUrl` 判易失本地 URL 回退 sidecar(5 单测)。
  - **F-2 → REQ-041**:effort chip 对上游英文 variant 模型(deepseek=**cn 版默认**)失效——显示回退默认档 + 切换失败。修=`variant-normalize.ts` 双向规范化(5 单测)。
  - **F-3**(债务,记 B23 行):B23「静默清零」premise 与现引擎「loud 拒绝」行为不符。
- 用户在场目击 B4 坏配置测试(真实 `~/.opencode` 注入),**配置已还原、app 恢复健康**;截图/备份在 audit 目录。
- gate 全绿(425 单测,+10 新)。两修复 verified = ship2 重打包批(F-1 植陈旧 key 回退 · F-2 deepseek switch 实拍)。
- **未跑归下批/用户批**:M 组 4 项 · C1 云回流 · B2 · B5-B8 · 及 REQ-016 既有用户批残单(B2 短TTL/logout/真断网/真睡眠等)。时间用于 P/B/C 组 + 修两个 bug,M 组时间未及、非阻断。

## 审计收尾(2026-07-06 追记)
S20 批次审计(全批走查后)发现并处置四类账面问题:
- **回写补正**:B6(C2 达成 G1)/C28(B1 打包态闭环)补翻 verified(sprint gate 原清单漏兑现);B4 不翻原因写明(深层断言未取证);REQ-016 残余摘 B6。
- **单测口径修正**:原「F-1 9 单测 / F-2 10 单测」误记(断言数与 test 数混淆)——实际 **+10 test / 32 断言**(两文件各 5);BACKLOG/verify.md/本档已统一。
- **审计发现两债务登记**:REQ-042(F-1 静默丢弃无日志+陈旧键不清理)、REQ-043(cycle 90ms DOM 轮询竞态)。
- **分支卫生**:按 ADR-005 清理已并短命分支(含本批 fix/s20-realmachine-f1-f2 及 S18/S19 遗留)。
- 本节与上方矩阵状态列同批补记(状态列开批时漏填)。
