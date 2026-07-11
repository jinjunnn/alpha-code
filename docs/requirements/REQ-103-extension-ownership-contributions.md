---
id: REQ-103
title: 扩展所有权与受控贡献槽：Hub Governance IA + capability grants + 顶级路由保护
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/212
repo: A
created: 2026-07-10
source: 2026-07-10 产品能力与路由/扩展所有权专项审计；用户要求拆为独立 REQ
---

## 背景

现有 `official/community/alpha/user` 将作者身份、Alpha 策展和支持责任混在一起；Hub 也容易把发现、安装、启用和健康状态混成一个标签。扩展增加后，第三方 UI 或 engine plugin 还可能反向稀释 Alpha 的页面/路由所有权。

## 目标与交付

1. UI 和 schema 使用 authored、curated、distributed、runtime surfaces、support tier 五维所有权。
2. Hub 信息架构收敛为 Discover、My Config、Create & Import、Governance；global/project context、可获得性、激活态、健康和安全状态分别呈现。
3. capability diff 展示 filesystem、network domains、process command heads、secrets、browser、screen control、engine hooks；权限增加必须重新确认。
4. 定义 Alpha-controlled contributions：Skill、Agent、MCP tool、Workbench tab、Artifact renderer、Settings panel；禁止第三方覆盖 `/`、Session、Settings、AlphaShell/Router。
5. 第三方 UI 只能运行在 Alpha 创建的 sandboxed `WebContentsView`、独立 renderer process 或 worker；Electron 不采用 `<webview>`，不提供主 renderer preload bridge。
6. Extension route 如确有需要，只能进入 `/extensions/:publisher/:id/*` 命名空间，并随 disable/uninstall 原子移除。

## 验收标准

1. Microsoft authored/Alpha curated 的示例不会显示成 Alpha authored；每个条目的分发责任、运行位置和支持等级清晰可达。
2. 用户能分别判断“已缓存”“已安装但关闭”“已启用”“运行健康”“撤销/隔离”，状态转换有测试。
3. capability 增加时静默更新被阻断；拒绝授权后旧版本不受影响。
4. 恶意 extension 尝试注册顶级路由、读其它 namespace 设置、获取 preload bridge 或注入 renderer JS 均被拒绝。
5. global/project 同名项在 My Config 中可区分、单独操作，并与 REQ-099 receipt 真相一致。
6. Dialog、tab、card、permission diff 和状态 badge 通过键盘、读屏和 reduced-motion 基线。

## 非目标

- 不在本项实现具体 Artifact renderer（REQ-095/096）或 Browser（REQ-106）。
- 不允许任意第三方顶级页面/路由。
- 不实现安装事务、CAS 或签名协议。

## 依赖与激活条件

- 依赖 REQ-099；涉及更新/回退的交互依赖 REQ-100。
- Artifact renderer contribution 的生产启用依赖 REQ-094/096 的隔离 host 验证。
