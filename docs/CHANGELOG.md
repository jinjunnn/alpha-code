# Changelog

> 只记**用户可见**变化(功能 / 修复 / 安全 / 性能);内部债务只翻 `BACKLOG.md`。
> 写入时机:随实现 PR 写 `[Unreleased]`(ADR-018 §6);打版发布时改版本号。版本 = ui-mac 发布(GitHub Release `jinjunnn/alpha-code`)。

## [Unreleased]

### Security
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
