---
id: D9
title: 分支命名 DB 累积清理(dev 机器关切)
type: debt
priority: P3
status: rejected
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.4 / R6(按渠道,prod 单库)
---

## 背景/证据
`opencode-<channel>.db` 按渠道累积(R6 修正:按渠道非按分支;prod 用户单库无累积);dev 机器上各开发渠道 DB 含完整会话历史无清理(如 feat-ui-redesign 6.4M 孤儿)。仅 dev 关切。

## 验收标准
1. dev 清理路径:脚本或文档(列出孤儿 DB 识别与安全删除步骤);
2. prod 无影响确认记录;
3. 可并入 C16 的数据清除入口(显示各库大小)。

## 关联
C16、opencode-channel-db-persistence(memory)。
