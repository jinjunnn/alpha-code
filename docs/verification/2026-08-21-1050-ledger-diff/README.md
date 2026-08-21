---
title: REQ-129 #1050 —— web_search / dispatch 账本差分
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-21
review_after: 2026-11-20
---

# alpha-code#1050 · 账本差分取证

父需求：[alpha-work#50](https://github.com/jinjunnn/alpha-work/issues/50) AC4。

## 结论

| 判据 | 结果 |
| --- | --- |
| `cloud_web_search` reserve → consume → settle | **PASS**（`tool.web_search` `reservation_created` + `allowance_consumed` ×2 窗 + `reservation_settled`） |
| 费用归属调用租户 | **PASS**（`externalRef` = 本机 `sk-alpha-*` key id；5h/7d 各 +15 credits） |
| `cloud_dispatch` 受理 | **PASS**（返回 `job_id`，随后 `cancel` `accepted:true`） |
| `cloud_status` / `cloud_artifacts` HTTP 200 | **PASS** |
| 只读工具无额外 `tool.web_search` 直接费 | **PASS**（dispatch 相位新事实无 `tool.web_search`；status/artifacts/cancel 未新增该 actionId） |
| 钱包余额 `balanceFen` | 本轮搜索扣在 **allowance**（`balanceFen` 差分 0），与「订阅额度池」口径一致 |

真源：[`results.json`](results.json)（无密钥明文）。

## 方法

1. CDP 读 `window.api.account.summary` + `transactions`（装机版 0.1.3，`ALPHA_CDP=1`）。
2. 用稳定路径 `~/Library/Application Support/alpha-verify/ALPHA_CLOUD_API_KEY` 的 `sk-alpha-*`（cloud scope）打公网 `/mcp`。
3. 两相位：先 `cloud_web_search`；再标准 `cloud_dispatch`（bounded-agent）→ status → artifacts → cancel。
4. 以 `maxSeq` 切新账本事实。

## Non-goals

不证明 provider 故障零 settle（E2，平台仓）；不证明 Queue 重放幂等（E3）。
