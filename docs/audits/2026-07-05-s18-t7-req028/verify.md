# REQ-028 验收记录 —— composer 真只读档(S18 T7)

> 2026-07-05/06。通道选型(档内记录):config 注入 alpha 自有 readonly agent + agent.cycle 判停。

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 「只读」后 edit/写**真被 deny** | ✅ 机制 PASS | 裸引擎(OPENCODE_CONFIG_CONTENT 同通道):alpha-readonly 进 `/agent`,合并 permission 表含 `edit:* deny` + `bash:* deny`(build 对照无);执行层 deny 语义 = ADR-022 readonly 档 REQ-016 真机已证同机制(实调建文件+bash 被 deny 零 ask);会话级实拍 → 真机批 |
| 2 | 切换失败诚实呈现 | ✅ 代码级 | switchAgentTo:控件未渲染/转满一圈未命中 → false → perm 回退 + popover 行内错误(「已回退」),绝不显示只读却可写(C28) |
| 3 | customAgents 门控行为明确 | ✅ | alpha-defaults 一次性 seed showCustomAgents=true(sentinel,用户改回尊重);门控关闭时 readAgentDom() null → 走②失败路径明示 |
| 4 | chip 与引擎 agent 一致(观察源) | ✅ 代码级 | composer-inject 从上游 `[data-action=prompt-agent]` 触发器文本发布 agentLabel;createEffect:label=alpha-readonly ⟺ chip 只读,外部 cycle 切走自动跟随 |

- 治理保护:ALPHA_INJECTED_AGENTS += alpha-readonly(X2,禁 hide/disable);交互差异 vs alpha-automation:question/task 允许(有人在场)
- 逃生:ALPHA_READONLY_DISABLE;上游锚点 prompt-agent 已入 REQ-012 anchors 清单
- 残单(→真机批):chip 三档像素、cycle 实切、会话内 edit 被 deny 实拍
