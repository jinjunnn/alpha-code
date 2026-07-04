# S13 T7+T9 视觉核验(筛选/反馈体系 + 供给链)

> 2026-07-04 · 隔离实例(OPENCODE_TEST_ONBOARDING)· CDP 断言 + 截图。

## T7 筛选 + 反馈

| 断言 | 结果 |
|---|---|
| 来源/许可证筛选 chips(8 枚):官方 → 4 张技能卡;+MIT → 0 张 → 空态引导「清除筛选试试」+ 清除按钮 → 恢复 6 张 | ✅ t7-01 |
| 失败行内化:安装失败 → 卡片错误行 / 详情页同源行内(onAdd 全类型改 setErrFor,零裸失败 toast);套件部分失败 → 条目行内 + 详情逐项重试 | 代码路径(更新/导入的行内失败已在 T5/T6 实证) |
| 安装阶段状态机:MCP = 检查依赖…→安装中…;其余 = 安装中…(按钮文案) | 代码路径 |
| 已安装骨架屏(引擎状态未就绪时 3 行 shimmer) | 代码路径(reduced-motion 关动画) |

## T9 供给链(REQ-023)

| 断言 | 结果 |
|---|---|
| Agent 进 catalog:「可安装的 Agent · 1」grid;添加 = 详情页先行(md 定义含权限档 frontmatter 全文预览) | ✅ t9-01 |
| Agent 安装:详情页安装 → writeAgent 管线 → receipt `agent:code-reviewer` | ✅(IPC 读回) |
| vendored 插件零网络:安装插件 → 风险确认框 → 复制 resources/plugins → `~/.alpha/plugins/opencode-notify/plugin.js` + **config plugin[] = 绝对路径**(无 npm 参与,供给全程本地) | ✅ t9-02 + config/文件断言 |
| vendored 卸载净除:config plugin[] 清空 + plugins 目录删除 + 账本去项 | ✅(三重断言) |
| **断网真机实测**(REQ-023 验收①,关 Wi-Fi 全程):零网络由构造保证(资产随包、无下载步),真机断网走查归 T8 真机批(与 REQ-016 同场) | ⏳ 如实递延 |
| OpenCodeNotifier.app 未再分发(公证风险),osascript 回退;NOTICE 已记 MIT 条目 | 见 resources/plugins/opencode-notify/README.md |
