---
id: B23
title: strict-key 配置致瘫:全局 jsonc 失败静默清零的防护与呈现
type: bug
priority: P1
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §7b / memory opencode-config-v1-schema
---

## 背景/证据
上游 `config/parse.ts:40-53` 未知 top-level key 硬抛 → 全局 `opencode.jsonc` 失败时 `config.ts:281-289` `orElseSucceed({})` **整份全局配置(MCP/模型/plugin)静默清零**,仅一行 log。alpha `persistMcp` 持续写同文件,叠加风险。上游解析行为不可改;alpha 杠杆 = 写前校验 + 失败呈现。

## 验收标准
1. alpha 所有写 `opencode.jsonc` 的路径(persistMcp/persistProvider/persistPlugin)写后回读 parse 校验,写坏立即回滚 + 告警;
2. 启动检测:全局配置解析失败(生效配置为空但文件非空)→ 用户可见告警 + 指出坏 key(经 B11 呈现面);
3. 用户手改坏配置的恢复指引(错误信息里给文件路径与备份提示)。

## 关联
B11(呈现面)、C2(写校验已有,扩回读)、memory [[opencode-config-v1-schema]]。
