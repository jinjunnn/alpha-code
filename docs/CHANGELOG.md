# Changelog

> 只记**用户可见**变化(功能 / 修复 / 安全 / 性能);内部债务只翻 `BACKLOG.md`。
> 写入时机:随实现 PR 写 `[Unreleased]`(ADR-018 §6);打版发布时改版本号。版本 = ui-mac 发布(GitHub Release `jinjunnn/alpha-code`)。

## [Unreleased]

### Added
- alpha 自有后端扩展开始随包分发:内置 `alpha_ping`/`alpha_echo` 工具(agent 工具表可见),是后续 alpha 自有工具/能力线的装载通道(B6/G1,需下个签名版本生效;`ALPHA_EXT_DISABLE=1` 可关)
- 模型目录按版本显隐(国内版/国际版):平台代理与内置「自带 Key」目录由网关白名单驱动,登录或打开模型面板即同步、无需更新 app;离线时回退内置目录并显示「内置目录」徽标;用户自定义添加的节点不受版本限制(REQ-001)
- 登录态自动续期:登录一次长期有效——token 到期前自动轮换刷新,不再出现「用着用着平台模型突然 401/要求重登」;仅当会话在网页端被撤销时才要求重新登录(B2,需下个签名版本生效)

### Fixed
- 启动提速:不再每次启动都等待登录 shell 探测(.zshrc 里 nvm/conda 慢时最坏 ~10s 黑屏)——上次结果缓存即开即用,探测转后台刷新(B1,首次启动仍会探测一次)
- BYOK 改密钥/删密钥即时生效:不再需要重启 app——改完立刻用新 key 调用,删除立刻吊销(此前旧 key 会滞留到重启)(B21)
- 界面回归根治:此前每日上游同步会静默打断 alpha 的界面定制(用户消息/工具卡/发送按钮/新对话等多处样式回落),已将上游前端冻结在 6/30 验证过的状态、每日同步只进引擎——同类回归物理上不再发生(REQ-013/ADR-020;界面恢复随下个版本生效)
- 平台代理用量计量:流式对话(OpenAI-wire)的 token 用量此前**全量丢失**、账户用量恒为 0——已修复,登录后经平台模型的每次对话都会正确计入今日/本周用量与套餐窗口(REQ-002 BP-1,网关侧)
- 冷启动登录态:app 重启后不再错误显示「未登录」——已存储的登录凭证在启动时可靠恢复(REQ-002 BP-2,需下个签名版本生效)

### Security
- 自动更新不再允许降级:防止更新源被替换/重放旧版本把 app 打回含已修漏洞的版本(需要旧版时手动下载对应 Release 的 dmg)(B9)
- **第三方 MCP/LSP 不再继承你的密钥**:此前任何安装的连接器子进程都能从环境变量读到平台登录凭证与全部 BYOK 模型密钥;现改为白名单环境 + 文件通道,密钥不再进入子进程环境(附带:登出即时吊销密钥文件;`echo $ALPHA_API_KEY` 在 agent 终端输出为空属预期)(A6,需下个签名版本生效)
- websearch 改为始终走 keyless 公共端点(限流版):`EXA_API_KEY` 不再透传给引擎——自有 Exa key 用户如需恢复,设 `ALPHA_ENV_ALLOWLIST_EXTRA=EXA_API_KEY`(A6 附带)
- 定制中心内置连接器目录钉精确版本:一键安装的 MCP 不再每次在线解析 `latest`,消除版本漂移与供应链不确定性(钉值 = 更新当日各包 latest,行为一致仅冻结确定性;存量已装配置的迁移待后续)(A2-续)

## [0.1.0] - 2026-07-03

**首个签名 + 公证的对外发布**(Developer ID + Apple 公证,`stapler validate` / `spctl: Notarized Developer ID` 双过;自动更新 feed 指向自有仓库)。

### Added
- alpha 品牌 Mac 应用:prod 渠道 `productName=alpha-code`、appId `com.tide.alphacode`、深链 `alpha-code://`(C18 / A5 / ADR-012 / ADR-017)
- 自有前端接管(ADR-016):AlphaHome 首页、侧栏、composer、模型选择器、设置、alpha-ui 设计系统
- 定制中心:MCP 浏览 / 一键安装 / 启停、skill / agent 创建、plugin 安装、内置技能种子(ADR-014)
- 平台账户体系:浏览器授权登录(PKCE 深链)、平台代理模型(platform-pays)、BYOK 钥匙串管理(ADR-017)
- 关于面板 + MIT NOTICE 随包分发(B15)
- websearch 对所有 provider 默认放开(ADR-009)

### Fixed
- 启动性能:窗口先行、定制中心惰性加载、渲染层取数减半(A1 / A2-部分 / A3,PR #22–#26)
- 内嵌 server 版本 `local` → 真实 npm 版本:带 `.opencode` 插件的项目首个请求不再被必败安装阻塞(A4,PR #33)
- 鉴权生命周期:过期重登后代理恢复、登出清 token 不串台(A8,PR #29)
- 崩溃屏去 OpenCode 品牌、版本不再显示 0.0.0(C29 / A5)

### Security
- 深链日志脱敏、外链 scheme 白名单、MCP 配置写入校验(反注入)、端点 https 守卫、IPC 导航 / store 硬化(C11 / C13 / C2 / C26 / C1,PR #22 / #25)
