---
id: B9
title: 更新链完整性:关 allowDowngrade + 完整性校验
type: security
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.2 / R5
---

## 背景/证据
R5 已修尖角:feed owner 从 anomalyco/opencode 改指 `jinjunnn/alpha-code`(PR #32),v0.1.0 起 feed 为自有签名产物。剩余:`allowDowngrade=true` 仍开(降级攻击面,`updater-controller.ts:45-55`)+ 更新链完整性依赖(zip-vs-yml SHA + macOS 签名)未显式核验成链。

## 验收标准
1. `allowDowngrade` 关闭(或写明保留理由与补偿控制);
2. 更新完整性链核实并文档化:latest-mac.yml SHA → zip → app 签名校验各环节实测(含篡改 yml 的失败用例);
3. 分发后的更新路径实测:v0.1.0 → 下一版真机自动更新成功。

## 关联
A7(签名,已 verified)、B7(发版流水线)、C27(fuses,邻接加固)。
