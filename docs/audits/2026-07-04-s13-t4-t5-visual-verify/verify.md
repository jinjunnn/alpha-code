# S13 T4+T5 视觉核验(实时依赖检测 + 更新通道)

> 2026-07-04 · 分支 feat/s13-t4-t5-deps-updates · 隔离实例(OPENCODE_TEST_ONBOARDING profile,其 alpha 根 = 每启动临时 alpha-home,真实 ~/.alpha 从未存在)· CDP 断言 + 截图。

## T4 实时依赖检测

| 断言 | 结果 |
|---|---|
| 进 MCP 详情页即实时 which:markitdown(uv)→ 「uv ✓」绿 pill | ✅ t4-01 |
| Git 操作(uv+git)→ 双 ✓ | ✅(断言输出) |
| IPC 负例:`checkRuntime("definitely-missing-xyz")` → `{ok:false}` | ✅(真实 which miss) |
| **缺失分支像素证据**:`checkRuntime` 用硬编码 PROBE_PATH,无法无侵入模拟缺失;contextBridge 冻结无法 stub → **归 T8 真机批(卸 uv 实测,REQ-019 验收④原文即真机步骤)**。组件三分支(checking/ok/missing)同一数据通路,typecheck 覆盖。 | ⏳ 如实递延 |

## T5 更新通道(端到端)

| 步骤 | 结果 |
|---|---|
| 预埋旧版 receipt(skill-creator@2026-06-01.1)→ 已安装 tab 琥珀角标「1」 | ✅ |
| 「有更新」分组行:`2026-06-01.1 → 2026-07-03.1`(版本 diff 摘要) | ✅ t5-01 |
| 点「更新」→ skill 按 catalog 钉版覆盖重装 → receipt 翻新 `@2026-07-03.1` | ✅(IPC 读回断言) |
| 角标消失、分组清空 | ✅ t5-02 |
| MCP 更新路径 = 确认框重装(persistMcp 覆盖写,静默重装会丢 {file:} 密钥引用 → 显式重填) | 设计拍板,代码路径 = stageInstall 确认框 |
| 「全部更新」= 逐条执行同管线 | 代码路径复用 runUpdate 循环 |
