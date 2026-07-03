---
id: REQ-016
title: 真机验证收尾批:登录门控/破坏性 4 项(A6 R3 解锁 / B2 短TTL / REQ-002④ logout / B3 in-app)
type: spike
priority: P1
status: registered
repo: X
created: 2026-07-03
sprint: —
---

## 背景(为什么)
S9+S10 的真机验证已完成**自动可验部分**(prod 签名+公证包,CDP+日志:冻结前端/B6/REQ-001/REQ-002 登录/A6 文件通道+BYOK 均 verified,见 [audits/2026-07-03-realmachine-verify](../audits/2026-07-03-realmachine-verify.md))。剩 4 项**要么登录门控、要么破坏性、要么需改 prod 配置**,不宜自动/擅自做,收敛为本测试需求后续统一执行。

## 待验 4 项(逐项验收 + 前置)

| # | 项 | 验收标准 | 前置/风险 |
|---|---|---|---|
| 1 | **A6 验收② MCP 子进程 env dump** → 通过后 A6 翻 verified + **解 R3 门控**(解锁 A2b、E2/E6) | 登录态装一个 MCP(如 filesystem),dump 其子进程 env:无 `ALPHA_API_KEY`/BYOK 密钥/`ALPHA_CLOUD_TOKEN`/`EXA_API_KEY` | 需装 MCP;或经评审接受「白名单单测 + OPENCODE_CONFIG_CONTENT 不再含明文 + BYOK 经 {file:} 正常」间接证据解 R3(拍板) |
| 2 | **B2 短TTL 全路径** | 临时把 alpha-web `DESKTOP_ACCESS_TTL_SECONDS` 调短(如 120s):①过期→自动续期无感 ②网页端撤销会话→降级登出有 UI | **改 prod alpha-web env**(侵入,用后还原)或本地起 web |
| 3 | **REQ-002④ logout 停代理不串台** | app 内 logout → 平台代理即停、密钥文件(A6)吊销、不串到下次登录身份(A8 复验) | **会登出当前 app 会话**(破坏性,需接受) |
| 4 | **B3 in-app 云闭环** | 配 cloud MCP(`ALPHA_CLOUD_MCP_URL`)→ 会话内经 `cloud_dispatch` 派任务 → SSE 进度 → 结果回会话(B 链 dev 已全绿,见 [audits/2026-07-03-b3-cloud-loop](../audits/2026-07-03-b3-cloud-loop.md)) | 需 cloud MCP 端点注入(登录态 platform 模式已带) |

## 方法(沿用本轮已验通的手法)
- prod 签名包 CDP(`ALPHA_CDP=1 open -a … --args --remote-debugging-port=9222`)截图 + `~/Library/Application Support/ai.opencode.desktop/logs/<run>/main.log` 取证;
- B 侧临时验证用 dev-token 窗口法(见 memory [[alpha-platform-devtoken-window]],用后回滚复验 401)。

## 完成后回写
逐项通过 → 对应 ID 翻 verified(A6/B2/REQ-002/B3);A6 verified 时 BACKLOG 记 R3 门控解除 + 解锁 A2b/E2/E6。

## 非目标
- 不在本批修 REQ-015(冻结偏斜)——独立债务。

## 关联
[[A6]] R3 门控、[[B2]]、[[REQ-002]]、[[B3]]、审计 realmachine-verify / b3-cloud-loop、memory visual-verify-required。
