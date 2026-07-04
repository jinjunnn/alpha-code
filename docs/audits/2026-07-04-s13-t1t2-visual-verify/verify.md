# S13 T1+T2 视觉核验(横向 IA + 详情页 + 三档安装分流)

> 2026-07-04 · commit `efa6cc59` · 隔离测试实例(`OPENCODE_TEST_ONBOARDING=1` + `ALPHA_GLOBAL_DIR` 沙箱,未污染真实 `~/.alpha`)· CDP `Page.captureScreenshot`(fromSurface)+ `Runtime.evaluate` DOM 断言。
> 纪律依据:[[visual-verify-required]];sprint gate「visual-verify(每新详情页 CDP 截图)」。

## DOM 断言(全部 PASS)

| 断言 | 结果 |
|---|---|
| 横向 tab = 9 个(推荐/连接器/技能/Agent/插件/套件/已安装/创建/云能力) | ✅ `[".alpha-ext-tab"] → 9 项与定稿一致` |
| 插件卡「添加」→ 进详情页(不直接装);面包屑首级 =「插件」;头部按钮 =「安装插件」 | ✅ |
| 详情页「安装插件」→ 确认框弹出且含风险行(「⚠ 插件代码将运行于引擎进程内…」) | ✅ |
| Esc 在确认框打开时只关弹框(详情页保留) | ✅ dialog:false / detail:true |
| Esc 再按 → 回列表(详情关闭) | ✅ |
| 技能卡「添加」→ 无确认框直装;toast「已添加 · 当场生效」;账本入账(已安装列表出现「技能创建助手」) | ✅ |
| GitHub(MCP 需密钥)「添加」→ 确认框 + 密文密钥输入;无风险行 | ✅ |
| 全局搜索:输入 "git" → 跨类目分组(连接器·2 / 套件·1);切到「套件」tab 查询词保留 | ✅ |

## 截图

| 文件 | 内容 |
|---|---|
| h01-featured-tabs.png | 推荐页 + 9 横向 tab |
| h02-plugin-detail-first.png | 插件详情页(面包屑「‹ 插件 / 完成通知」+ 头部右侧「安装插件」+ 待核实条 + 数据边界) |
| h03-plugin-risk-confirm.png | 插件安装风险确认框 |
| h04-skill-direct-install.png | 技能直装(无弹框,toast) |
| h05-mcp-key-confirm.png | MCP 密钥确认框 |
| h06-search-persist.png | 全局搜索跨 tab 持久 |
| h07-installed.png | 已安装列表(直装技能已入账) |

另:早期左栏版(已废)的 16 屏核验记录随该版本一并作废,不留档。
