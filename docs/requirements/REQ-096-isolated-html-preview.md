---
id: REQ-096
title: 隔离 HTML Artifact Preview —— 一次性静态 host、独立进程/worker 与零 preload bridge
type: security
github_issue: https://github.com/jinjunnn/alpha-code/issues/208
repo: A
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10);用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

主 BrowserWindow 当前采用 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`，并在 `packages/ui-mac/src/main/windows.ts` 阻止离开应用 origin；`renderer-security.ts` 的 CSP 还禁止 `frame-src`/`object-src`。HTML 目前之所以安全，主要是产品完全不执行它。不能为了预览 artifact 在主 renderer 放宽全局 CSP，也不能把不可信 HTML 放进拥有 Alpha preload bridge 的上下文。

HTML artifact preview 与可交互 Browser 是两个权限域：前者默认静态、禁脚本、禁网、一次性；后者有 origin/profile/navigation，必须由 [[REQ-106]] 单独治理。

## 目标与交付

1. 建立 main-owned `HtmlPreviewHost`，实现可审计的隔离方案：sandboxed `WebContentsView`/独立 renderer process，并把净化、解析等 CPU 工作放独立 worker；不使用主 renderer iframe 或 Electron `<webview>`。
2. preview webContents 必须 `nodeIntegration=false`、`sandbox=true`、`contextIsolation=true`，且无 Alpha preload、无 `window.api`、无 Node/Electron/MCP/secret/session 能力。
3. 默认静态 CSP：`default-src 'none'`、`script-src 'none'`、`connect-src 'none'`、`frame-src 'none'`、`object-src 'none'`、`form-action 'none'`、`base-uri 'none'`；仅按需要允许受控的 inline style 与由 ArtifactService 提供的 `blob:`/自定义协议图片和字体。
4. main 侧拒绝全部导航、重定向、popup、permission、download、upload、clipboard、camera、mic、geolocation、notification 和外部协议。子 frame、CSS URL、SVG/image、meta refresh 也走同一 deny policy。
5. 使用成熟 sanitizer/安全 DOM 解析作为纵深防御，但安全性不依赖 sanitizer 单点；即使净化遗漏，进程、CSP、协议和网络策略仍阻止越权。
6. 每次预览使用短生命周期实例/partition；关闭、切换、超时或 crash 时销毁 webContents、worker、临时协议授权和缓存。崩溃只影响 Preview 区。
7. 提供 Source/Metadata、被阻止资源清单和“在系统浏览器打开副本”的显式动作；绝不把静态 Preview 静默升级成可交互浏览器。

## 可验证验收标准

1. 正常静态 HTML/CSS/内嵌 data image 能在 [[REQ-094]] Preview 显示；script、module、event handler、iframe、object/embed、form、meta refresh、外链 CSS/font/image 均不执行/不请求。
2. 恶意 fixture 覆盖 XSS、DOM clobbering、`javascript:`/`file:`/custom protocol、CSS exfil、SVG script、service worker、WebSocket/fetch、popup、download、clipboard 与表单提交；抓包及 main policy 日志证明零外网请求和零 Alpha bridge 访问。
3. preview 内 `window.api`、`require`、`process`、Electron 对象、session token 和主 renderer storage 均不可见；partition cookie/localStorage 与主应用完全隔离并在销毁后清空。
4. 导航与权限 handler 对初始 URL、redirect、subframe、popup 和外部协议全部 default-deny；策略单测和打包态集成测试同时通过。
5. 解析超时、内存预算超限、renderer crash 和 worker crash 均显示可恢复 fallback；Session/Composer/Workbench 其他模式继续工作。
6. 打包后的 macOS 与 Windows 真实应用各完成一次静态预览安全 smoke；dev-only 放宽或 `ALPHA_CDP` 不得改变 packaged policy。
7. 主 renderer `RENDERER_CSP` 不因本需求增加 `frame-src`、任意 `script-src` 或通用外网域；代码审查门禁止给 HtmlPreviewHost 配置 preload bridge。

## 非目标

- 不提供登录、cookie 持久化、表单提交、网页调试、agent 点击/输入或任意 JavaScript 执行；这些属于 [[REQ-106]]。
- 不把 HTML 转成“可信 Alpha UI”，也不让 artifact 贡献顶级 route/Shell。
- 不承诺服务端应用在静态模式下可工作；此类内容应使用受限 Browser 或系统浏览器。
- 不放宽主窗口 CSP 来兼容单个 artifact。

## 依赖与激活条件

- 依赖 [[REQ-094]] 的 Preview host 生命周期；内容通过 [[REQ-092]]/[[REQ-093]] 的受控 source 取得。
- 安全基线引用 [[C24]]、`packages/ui-mac/src/main/renderer-security.ts` 与 `windows.ts`；不得降低现有主窗口隔离。
- [[REQ-106]] 依赖本需求验证过的 host/进程隔离原则，但必须使用独立权限域、partition 和 broker。
