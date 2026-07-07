---
id: B21
title: BYOK 改键/删键即时生效(不达 sidecar 修复)
type: bug
priority: P1
status: verified
repo: A
created: 2026-07-03
sprint: 2026-07-03-s10-hardening
source: 册 §7b
---

## 背景/证据
`setByokKey` 只写钥匙串(`provider-ipc.ts:20`),不重注 env、不 respawn → picker 显「已配置」(读钥匙串)但模型读 `process.env`(`alpha-models.ts:54`)仍空 → 401 至重启;删键同样留陈旧 env。A8(PR #29)已给 respawn 重导地基,但改键动作本身不触发。

## 验收标准
1. 改键/删键后**无需重启**即生效(触发重注 env + respawn,或运行时转发);
2. picker 显示状态与 sidecar 实际可用状态一致(改键后立即发消息成功);
3. 删键后模型立即不可用且有明确提示(非静默 401);
4. 并发保护复用 B5 的 respawn 互斥。

## 关联
A8(地基)、B2(同域)、B5(互斥)、REQ-002(联调实测场)。

## 采纳方案(2026-07-03,PR #48)
根因:`injectByokKeysIntoEnv` 旧实现 set-if-unset——改键后旧值滞留 main env → syncSecretFiles
镜像旧 key → 新 fork 仍用旧 key。修:变更计算抽纯逻辑 `alpha-byok-env.ts`(5 单测)——用户提供的
env 值永不动;本模块注入过的 var 权威可变(改键覆盖 / 删键清除);`setByokKey/removeByokKey`
持久化成功后经 `setByokKeyDeps.onChanged` 触发「重注 env + respawn(B5 单飞)」→ fork 时 A6
把新 env 镜像进 {file:} 通道,新 sidecar 即用新 key;删键即时吊销(env 清 + 密钥文件删)。

## 验证记录
- 2026-07-03:5 单测(用户值不动/改键必覆盖/删键必清/幂等)+ 全量 gates 绿;真机改键即时生效 → 真机批。
- **2026-07-07 verified(装机 v0.1.2+PR#141/142,用户真 key 在场)**:验收①②③④全过——改键 4ms/respawn 2.5s/密钥文件即换新(旧 key 仍有效,文件内容为出账判定面)/真消息 4.6s 回;删键 3ms 即吊销(文件删+picker 需KEY行+引擎 loud 500);复键经真实 UI(需KEY行→测试连接 316ms→保存并启用)。证据 [audits/2026-07-07-b21-byok-realkey/verify.md](../audits/2026-07-07-b21-byok-realkey/verify.md)。场中发现 [[REQ-061]](弹层竞态挡死「已配置行改键」UI 入口;IPC/后端语义不受影响)。
