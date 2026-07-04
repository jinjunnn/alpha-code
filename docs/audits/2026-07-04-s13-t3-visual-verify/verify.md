# S13 T3 视觉核验(六类详情专属区块)

> 2026-07-04 · 分支 feat/s13-t3-detail-blocks · 隔离实例(OPENCODE_TEST_ONBOARDING=1 + ALPHA_GLOBAL_DIR 沙箱)· CDP 截图 + DOM 断言。

| 断言 | 结果 |
|---|---|
| MCP(GitHub)详情:tools[] 精选列表渲染(search_repositories 等 5 项)+ 「以实际连接为准」提示 | ✅ t3-01 |
| Skill(skill-creator)详情:SKILL.md 全文渲染(主进程只读 IPC,frontmatter 开头可见) | ✅ t3-02 |
| 未打包 skill(mcp-builder):诚实红字「技能内容未随此版本打包」,无占位 | ✅ t3-03 |
| Agent(build)详情:权限档摘要渲染(allow 绿/ask 灰,cap 10 + "+16" 截断);model/prompt 为可选字段,内置无覆盖时正确隐藏 | ✅ t3-04 |
| 超长 permission pattern 溢出修复(scrollWidth <= clientWidth) | ✅ t3-04b |
| Plugin(完成通知)详情:hooks 清单(event(session.idle))+ D4「插件 ≠ 套件」澄清条 + 风险与生效方式 | ✅ t3-05 |
| 套件(开发套件)详情:组合清单序号 1-4 + 未装子项行内「添加」按钮(逐项安装/重试,走各自类型分档) | ✅ t3-06 |
