---
id: REQ-016
title: 真机验证收尾批:登录门控/破坏性 4 项 + S12–S15 递延真机项(ADR-014 v3 / ADR-022 转 accepted 唯一门)
type: spike
priority: P1
status: shipped
repo: X
created: 2026-07-03
updated: 2026-07-05
sprint: 2026-07-05-s16-realmachine-batch
---

## 背景(为什么)
S9+S10 的真机验证已完成**自动可验部分**(prod 签名+公证包,CDP+日志:冻结前端/B6 部分/REQ-001 链路/REQ-002 登录/A6 文件通道+BYOK 均见 [audits/2026-07-03-realmachine-verify](../audits/2026-07-03-realmachine-verify.md))。剩 4 项**要么登录门控、要么破坏性、要么需改 prod 配置**,收敛为本需求统一执行。

**2026-07-05 范围刷新**(按 2026-07-04 用户拍板,把 S12–S15 四个 sprint 攒的真机递延项全部并入本批;本需求自此是 **ADR-014 v3 与 ADR-022 转 accepted 的唯一门**,优先级 P2→P1):
- 前置事实:已装 0.1.0(2026-07-04 14:07)不含 M2/M3/M4 代码(asar 无 extension-detail/automation-scheduler/cloud-envelope-guard 标记)→ 本批**先从 alpha HEAD 重 ship 签名+公证包**再执行。

## A 组 —— 原 4 项(登录门控/破坏性)

| # | 项 | 验收标准 | 前置/风险 | 执行方式 |
|---|---|---|---|---|
| A1 | **A6 验收② MCP 子进程 env dump** → 通过后 A6 翻 verified + **解 R3 门控**(解锁 A2b、E2/E6) | 登录态装一个 MCP,dump 其子进程 env:无 `ALPHA_API_KEY`/BYOK 密钥/`ALPHA_CLOUD_TOKEN`/`EXA_API_KEY` | 需装 MCP | agent 可做 |
| A2 | **B2 短TTL 全路径** | 临时把 alpha-web `DESKTOP_ACCESS_TTL_SECONDS` 调短(如 120s):①过期→自动续期无感 ②网页端撤销会话→降级登出有 UI | **改 prod alpha-web env**(侵入,用后还原)或本地起 web | ⛔ 留用户批 |
| A3 | **REQ-002④ logout 停代理不串台** | app 内 logout → 平台代理即停、密钥文件(A6)吊销、不串到下次登录身份(A8 复验) | **登出后需用户手动重登**(浏览器 OAuth,agent 无法代办) | ⛔ 留用户批 |
| A4 | **B3 in-app 云闭环** | 配 cloud MCP(登录态 platform 模式已带)→ 会话内经 `cloud_dispatch` 派任务 → SSE 进度 → 结果回会话 + `.alpha/runs/<runId>/` 回流(兼 REQ-004 打包态冒烟) | 消耗平台额度(小) | agent 可做 |

## B 组 —— S12 递延(REQ-018/REQ-006/A2,ext-hub M1)

| # | 项 | 验收标准 |
|---|---|---|
| B1 | in-app 四步 ×4 类 | 签名包内:skill/MCP/agent/plugin 各走 安装→dispose 免重启生效→已安装态→卸载净除 |
| B2 | 迁移开门演练 | `ALPHA_MIGRATE_ENABLE=1` 启动:存量(可种子)迁 `~/.alpha` + 钉版重装,旧位净除(A2 尾项) |
| B3 | REQ-006 桌面验收用例 | 装 markitdown→免重启可用→卸载→依赖预检(与 B1 同场;过后 ADR-014 v3 转 accepted) |

## C 组 —— S13 递延(REQ-019/REQ-023,ext-hub M2;清单源 [audits/s13-acceptance](../audits/2026-07-04-s13-acceptance.md))

| # | 项 | 验收标准 | 执行方式 |
|---|---|---|---|
| C1 | 卸 uv 像素核验 | 依赖缺失 → markitdown/git 详情页「✗ 缺失 + brew 指引」像素证据(可用 PATH 遮蔽替代真卸载) | agent 可做 |
| C2 | 断网 vendored 走查 | 关 Wi-Fi → vendored 插件从点添加到引擎加载全程 + osascript 回退通知实际弹出 | ⚠️ 切网风险;可先以 nettop 零流量证据替代,真断网留用户批 |
| C3 | Git 导入真克隆 | 公网小仓库 https 浅克隆 happy-path 入账 | agent 可做 |
| C4 | dispose 打断活跃流 | 会话流式中途装/卸触发 dispose → 记录行为(残余风险定性) | agent 可做 |
| C5 | 打包件核验 | resources/{agents,plugins} 进 dmg;签名/公证不受 vendored js 影响(spctl/staple) | agent 可做 |

## D 组 —— S14 递延(REQ-020,cloud M3)

| # | 项 | 验收标准 |
|---|---|---|
| D1 | platform 点亮双态 | 登录 platform 态云分区点亮截图(BYOK 灰显态已 CDP 核验过,补登录态一侧) |
| D2 | guard 真发被拒 | 登录态真发:>1MB envelope 拒发 + 含密钥样本 diff/objective 拒发且指出字段(行内 loud) |
| D3 | code-review hub 端到端 | 从 hub 的 code-review 条目 dispatch diff-only → 进度 → 回流 `.alpha/runs/`(与 A4 同场) |

## E 组 —— S15 递延(REQ-021 A1,自动化;ADR-022 转 accepted 门)

| # | 项 | 验收标准 | 执行方式 |
|---|---|---|---|
| E1 | 到点触发+通知实拍 | 「每天 HH:mm」/once 任务真机到点触发 → run 落盘 + 系统通知横幅实拍 | agent 可做(once 近时任务) |
| E2 | readonly 零 ask | 自动化会话实调 edit/bash 被 deny、全程零 ask(构造试写 prompt) | agent 可做 |
| E3 | 重叠/错过用例 | overlap skip 记账;睡眠/退出期错过 → catchUpPolicy skip 可见不补跑 | 退出期错过 agent 可做;真睡眠留用户批 |
| E4 | 断电重启恢复 | 杀 app 重启 → 任务与 next-fire 恢复正确 | agent 可做 |
| E5 | 历史回跳 | 运行历史点击回跳会话原文与 run 产物 | agent 可做 |

## F 组 —— 散布 BACKLOG 的「verified 待真机」小项(同场顺带)

| ID | 项 | 验收标准 |
|---|---|---|
| REQ-001 | picker 截图 | edition 白名单显隐 + 降级徽标 |
| REQ-011 | 首页布局 | composer 下方 chips 已移除、布局不塌陷 |
| B1 | shell 探测缓存 | 缓存命中启动,main.log 计时对比 |
| D1 | 健康轮询首查 | main.log 首查即中、无 100ms 白等 |
| B6 | ext 接缝 | alpha_ping 进工具表且执行(G1 成功条件) |
| B11/B23 | banner 视觉 | 故意写坏配置 → warning banner 截图(备份还原) |
| B21 | BYOK 改键 | 改键→picker 即时反映(视凭证可得性,允许部分) |
| B22 | 时间线崩溃复现 | 真机复现尝试(修复前置);复现即录步骤 |
| REQ-014 | 悬空会话白屏复现 | 构造 tabs.recent 指向已删会话 → 冷启动观察 Not found 形态(整屏/布局内)→ 供修法拍板 |
| C3(日志) | 运行期轮转 | 膨胀 opencode.log >25MB → 重启触发归档 |
| REQ-007③ | Tier-3 回答长度 | explain 类提问回答长度校准实测(顺带,可选) |

## 方法(沿用已验通手法)
- 从 alpha HEAD `OPENCODE_CHANNEL=prod ALPHA_SIGN=1 ship:mac` 重打签名+公证包装机;
- prod 签名包 CDP:`ALPHA_CDP=1` env + 直接二进制启动带 `--remote-debugging-port`(env/args 不穿 `open -a`);`Page.captureScreenshot` 必带 `{fromSurface:true}`;hub 入场动画等 1.5s+ 再截;
- 日志取证 `~/Library/Application Support/ai.opencode.desktop/logs/<run>/main.log`;
- B 侧临时验证用 dev-token 窗口法(memory [[alpha-platform-devtoken-window]],用后回滚复验 401)。

## 完成后回写
逐项通过 → 对应 ID 翻 verified(A6/B3/REQ-018/REQ-019/REQ-020/REQ-021/REQ-023/REQ-006/REQ-004/B6/B1/D1/REQ-011/REQ-001…);A6 verified 时 BACKLOG 记 R3 门控解除 + 解锁 A2b/E2/E6;ADR-014 v3 与 ADR-022 视门转 accepted;B2/logout/真断网/真睡眠若未做 → 留「用户批」残单,不影响其余项翻 verified。

## 非目标
- 不在本批修 REQ-015(冻结偏斜)——独立债务;
- 复现类(B22/REQ-014)只求复现与定性,不在本批修。

## 关联
[[A6]] R3 门控、[[B2]]、[[REQ-002]]、[[B3]]、[[REQ-018]]/[[REQ-019]]/[[REQ-020]]/[[REQ-021]]/[[REQ-023]]、审计 realmachine-verify / b3-cloud-loop / s13-acceptance、memory visual-verify-required / ext-hub-v3-roadmap。
