---
title: 冷启动可用性 + token 轮换 打包版真机取证
kind: verification
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-25
review_after: 2026-10-25
---

# 冷启动可用性 + token 轮换 打包版真机取证(2026-07-25)

覆盖 **#536**(REQ-109/REQ-110 共享 VERIFY)矩阵的**冷启动分档**与**token-only 换血**两格。
被测件:`/Applications/alpha-code.app`,built 2026-07-25 10:42:04,基线 `514ae7438`
(含 #598 / #603 / #595 / #600-602 / #604 / #605-606 / #607 全部修复)。
证据来源:`~/Library/Application Support/ai.opencode.desktop.dev/logs/20260725T144219/startup-timeline.log`。

## 事故前对照(同一台机器,14 次冷启动)

修复前 `20260724T*` 至 `20260725T014826` **连续 14 个 session**:
`main.sidecar.generation.emit` 只发 `phase:"recovering" reason:"boot"`,**从未发出 `phase:"ready"`**;
`renderer.home.model_list.end` **全部 `outcome:"error:request"`**(每 session 8–25 次),
`ok` 计数为 **0**;重试 ~20 次后彻底静默,直到用户手动登出/登录才恢复。

## 本次冷启动实测

| 时刻 | 事件 | 结果 |
| --- | --- | --- |
| 10:42:19.849 | `generation.emit gen=1` | `phase:"recovering" reason:"boot"` |
| **10:42:20.496** | **`generation.emit gen=1`** | **`phase:"ready" reason:"boot"`** ← **修复前从不出现** |
| 10:42:20.693 | `renderer.sidecar.generation.received` | 收到 `ready`(不再是毒丸 `recovering`) |
| 10:42:21.409 | `model_list.end chain=1` | **`outcome:"ok"` count=5638, 621ms** |
| 10:42:22.567 | `generation.emit gen=2` | `phase:"recovering" reason:"token-only"` |
| 10:42:22.574 / 23.576 | `model_list.end chain=2` | `error:request` ×2(**换血窗口内的瞬态**) |
| 10:42:24.198 | `generation.emit gen=2` | **`phase:"ready" reason:"token-only"`** |
| 10:42:24.199 | `main.renderer.reload.skipped` | **`outcome:"continuity"`** ← token 换血不再整页 reload |
| 10:42:25.337 | `account_summary.end` | `outcome:"ready"` 17ms |
| 10:42:25.465 | `model_list.end` | **`outcome:"ok"` count=32, 194ms** ← **换血后自愈,无需用户操作** |

**从时间线起点(`main.timeline.epoch` 10:42:19.468)到模型目录首次可用(10:42:21.409)= 1.94s。**

## 对 AC 的支撑(逐条,含**不能**由本次取证支撑的部分)

### REQ-109(#528)
- **AC1 冷启动至模型目录可操作 P95 ≤ 2s** —— 本次**单样本 1.94s**,在门槛内。
  ⚠️ **单样本不是 P95**;要判 AC1 需按 #536 矩阵跑完分档(续期 50ms/1.5s/3s/10s、超时/5xx、热启动等)。
- **AC2 瞬态永不呈现「当前不可用」** —— 日志侧:两次 `error:request` 均落在 token 换血窗口内且
  随 `ready` 自愈,**未出现修复前那种「重试耗尽后永久静默」**。
  ⚠️ **UI 呈现未取证**(需 L2 截图确认那两秒内显示的是 recovering 而非「当前不可用」)。
- **AC3 generation ready 后 ~100ms 内重试** —— 本次 ready(24.198)后 composer 于 25.319 remount 并
  在 25.320 发起 model_list。⚠️ **该间隔 1.1s 来自 composer remount,不是退避残留**;
  是否满足 AC3 的字面口径需 owner 判读。
- **AC4 换血不整页 reload,renderer mount 保持 1** —— `main.renderer.reload.skipped {outcome:"continuity"}`
  ✅;但 `renderer.root.mount` 本次仅 1 次(10:42:20.687)✅。
- **AC5 account 不门控本地 model.list** —— chain 1 的 `model_list.ok`(21.409)**早于**首次
  `account_summary.start`(25.320)✅ 并行解耦成立。
- **AC6 非治理 MCP 不参与启动** —— 本次未取证(属 T6/#535 面)。
- **AC7 不得把未验证的过期 token 标成可用** —— 本次 `main.auth.boot.token_check {expired:true}`
  → `refresh.end {outcome:"ok"}` → 才 fork,路径正确;但「标成可用」的 UI 侧未取证。

### REQ-110(#529)
- **AC1 续期由 expiresAt 驱动** —— `main.auth.scheduler.arm {reason:"startup", delayMs:599361}`
  ✅(≈10 分钟,由 expiresAt 推导,非小时轮询)。
- **AC2 换血窗口内不再使用旧 token / 首次平台推理不 401** —— **未取证**,需跨两个 TTL 周期长会话。
- **AC3 续期失败分类** —— 本次为成功路径,失败分类**未取证**。
- **AC4 换血遇活动流式生成** —— **未取证**。
- **AC5 token 不进 sidecar env** —— 本次未直接取证;单测侧由 #603/#605 的 veto 矩阵覆盖。

## 附带证实的修复

- **#595 死远程字段停止传播**:本次写入的 `alpha-live-models.json`
  (`fetchedAt: 2026-07-25T14:42:22.564Z`)中 **`byokProviders` 为 `None`** ——
  平台 wire 的 `byok_providers` 不再被缓存/传播。
- **BYOK 密钥经文件通道物化**:`alpha-secrets/` 下 `DEEPSEEK_API_KEY`、`ZHIPU_API_KEY` 就位
  (A6 `{file:}` 通道,非 env)。

## 尚未取证(需交互,本轮未做)

1. **BYOK 未登录可选**(#595 退出条件 1)—— 需登出后观察 picker。
   本轮**未做**:登出会打断 owner 当前会话。单测侧已有六条退出条件覆盖。
2. **智谱 BYOK 真回合**(顺带补 REQ-125 批3 的 20 帧)—— 需交互发送并消耗 owner 的 API 额度。
3. **L2 视觉**:AC2 的「瞬态不呈现当前不可用」、以及 BYOK 行文案「引擎重启中 · 可先选择」。

## 结论

**冷启动 `phase:"ready"` 缺失这一根因已在打包版真机上确证修复**,
且 token-only 换血的终态与「不整页 reload」也一并生效。
**这不等于 #528/#529 可判完成** —— 上表中标 ⚠️ 与「未取证」的 AC 仍需 #536 矩阵其余格子。
