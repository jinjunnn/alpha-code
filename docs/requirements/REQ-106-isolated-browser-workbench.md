---
id: REQ-106
title: 隔离 Browser Workbench —— main-owned WebContentsView、session broker、权限策略与用户接管
type: security
github_issue: https://github.com/jinjunnn/alpha-code/issues/213
repo: A
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10)+Alpha Product Kernel 所有权方案;用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

当前产品没有 `<webview>`、`WebContentsView`、BrowserView 或面向用户的 Playwright/CDP broker。`ALPHA_SHOT` 与 packaged `ALPHA_CDP` 是开发/视觉审计能力，不是用户浏览器；Catalog 中的 Playwright MCP 也不提供 Alpha-owned 可见 session、权限 broker 或手动接管。

产品需要的是受限 Preview/Task Browser，而不是先造完整通用浏览器。它必须与主 renderer、[[REQ-096]] 静态 HTML Preview、系统默认浏览器和 dev 9222 CDP 明确分域。

## 目标与交付

1. 由 Electron main 创建和持有独立 `WebContentsView`，在 [[REQ-094]] Workbench 中按 capability 显示 Browser mode；不使用 `<webview>` 或主 renderer iframe。
2. 建立 `BrowserSessionBroker`：每个 session 有稳定 ID、owner（用户/agent）、项目、允许域、partition/profile、生命周期、权限与 action log；renderer 只能发送经 schema 校验的高层控制命令。
3. 默认使用临时独立 partition、无 preload、`nodeIntegration=false`、`sandbox=true`、`contextIsolation=true`；关闭后销毁，只有用户明确选择时才保存 profile/cookie。
4. Workbench 提供真实 URL/origin、back/forward/reload/stop、loading/error、TLS 提示、允许域、agent/用户控制状态，以及“暂停 agent/用户接管/恢复/关闭并销毁”。接管切换必须由 broker 原子仲裁。
5. main-side policy 覆盖初始导航、redirect、subframe、popup、permission、external protocol、WebSocket、download、upload、clipboard、camera、mic、geolocation 与 notification；默认全部拒绝，仅逐会话显式授权最小范围。
6. domain allowlist 对每次 redirect/subresource capability 和 DNS/IP policy 持续生效；localhost preview 与公网 session 分开配置。页面内容视为不可信输入，网页文案不能自行授权高风险动作。
7. agent automation 通过专用 Playwright/CDP broker 控制该 session，不复用 Alpha 主窗口的 9222，也不能附着其他 BrowserWindow/WebContents。
8. download 写入受管目录，经文件名、MIME、大小、sha256 和 [[REQ-093]] policy；upload 只接受用户 file picker 产生的一次性 token；clipboard 默认禁用，读取/写入逐次可见确认。

## 可验证验收标准

1. Workbench 可创建 localhost 与公网 allowlisted session，完成导航、刷新、停止、返回/前进、销毁；无 session 时 Browser mode 不显示空标签。
2. popup、未允许域、redirect 越界、subframe 越界、外部协议、camera/mic/geolocation/notification 默认拒绝；每次决策记录 session、origin、主体、动作、结果和时间，但不记录 secret 内容。
3. agent 操作时用户持续看到“控制中”状态，可一键暂停并接管；暂停后 broker 拒绝 agent 新动作，正在进行的输入/导航被取消；恢复需要明确用户动作。
4. 专用 broker 无法列出或控制 Alpha 主窗口、HTML Preview host 或其他 session；packaged 测试证明未打开/复用主窗口 9222。
5. download 超限/MIME 欺骗/恶意文件不落为成功文件；upload 没有 picker token、token 复用、路径替换和目录上传均拒绝；clipboard 后台读取为零。
6. 临时 session 销毁后 cookie/storage/cache 不可恢复；显式持久 profile 有名称、来源、删除动作和独立加密/权限策略，不与主应用 storage 混用。
7. 恶意页面/间接 prompt injection fixture 不能通过 DOM 文案批准登录、付款、发送、下载、上传或扩大 domain；高风险动作始终由 broker policy/用户确认决定。
8. macOS 与 Windows packaged 应用完成安全 smoke；Browser renderer crash/GPU crash 不影响 Session/Composer，broker 能清理并恢复新 session。

## 非目标

- 不实现浏览器扩展商店、密码管理器、完整书签/历史同步、多用户浏览器或取代系统默认浏览器。
- 不复用 [[REQ-096]] HTML Preview 的静态 host/profile，也不把 Browser 权限反向授予 artifact renderer。
- 不允许安装 Skill/MCP/Plugin 自动获得 Browser 权限；授权绑定主体、项目、会话和有效期。
- 不实现跨应用屏幕/键鼠控制；归 [[REQ-107]]。

## 依赖与激活条件

- 依赖 [[REQ-094]] verified 的 Workbench 生命周期与 [[REQ-096]] verified 的隔离 host 安全基线。
- 硬激活门：[[D5]] 的 owning Issue 必须完成验收，覆盖 Playwright 浏览器内核来源、首次下载、弱网与打包态；未完成前不得默认发版。
- 浏览器权限模型需与 [[C24]] CSP、[[C25]] 执行面及 `packages/ui-mac/src/main/windows.ts` 现有导航策略做 threat model 复核。
