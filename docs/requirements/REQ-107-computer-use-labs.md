---
id: REQ-107
title: Computer Use Labs —— 窗口级逐会话授权、持续可见控制、急停、审计与敏感动作确认
type: security
migration_note: "Not migrated: parked without a review date; activation requires a new GitHub Issue."
repo: A
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10);用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

当前 Alpha 没有结构化、受支持的跨应用屏幕观察/控制能力。Shell 能调用系统工具不等于产品具有安全 Computer Use；直接引入 screenshot + 全局坐标点击会把所有窗口、凭证、通知和键鼠置于最高风险权限域。

Computer Use 只适合作为明确标记的 Labs 能力，并且必须晚于隔离 Browser。优先使用选定窗口和 OS accessibility tree，逐级从观察走向有限操作，不能默认获得全屏或全局输入能力。

## 目标与交付

1. 四级 capability：①只观察选定 Alpha/Browser session；②用户批准后在选定窗口 click/type；③受限应用白名单自动化（优先 macOS Accessibility/Windows UIA）；④全局屏幕/键鼠仅研究模式、另行决策，默认关闭。
2. 每次授权绑定主体（agent/tool）、项目、会话、目标 app/window、允许动作和期限；窗口关闭、会话结束、目标变化、应用切换或超时立即失效。Skill/MCP/Plugin 无权自行授权或扩大范围。
3. 操作期间持续显示不可被目标内容遮蔽的红色“控制中”状态、目标窗口、当前主体与动作；提供 Workbench pause/stop 和系统级全局急停热键。急停必须优先于 agent 队列并撤销注入中的输入。
4. 每个观察/动作记录时间、主体、目标 app/window、accessibility target/安全坐标、动作、确认、结果与必要的脱敏截图引用；日志写入受控 run/Inspector，可导出和按 retention 清理。
5. 密码、OTP、支付、购买、删除、发送消息/邮件、提交表单、发布、权限提升、下载/上传、读取/写入 clipboard 等敏感动作逐次确认；确认 UI 由 Alpha trusted surface 渲染，不能由目标页面模拟。
6. 截图/观察只捕获授权窗口，默认裁剪其他窗口、通知、菜单栏和敏感字段；优先 accessibility node 语义，不把全屏绝对坐标作为唯一定位。
7. macOS Screen Recording/Accessibility 与 Windows UIA 等 OS 权限按需请求，解释用途并可撤销；未授权时诚实降级，不通过 shell 绕过系统 consent。
8. Labs UI 明确实验性、默认关闭、逐会话开启；建立 capability kill switch、版本/平台 allowlist 和安全事件一键禁用路径。

## 可验证验收标准

1. 首个可交付级别仅观察/操作用户明确选择的单个窗口；切换窗口、最小化/关闭、session 结束和授权过期后，后续截图、点击、输入全部拒绝。
2. 控制状态在 Alpha 与系统急停入口持续可见；全局急停在自动化连续输入期间生效，停止后 broker 队列清空且必须重新授权才能恢复。
3. 敏感动作 corpus 至少覆盖密码/OTP、支付、删除文件、发送消息、提交表单、clipboard、上传下载和系统权限；没有 trusted Alpha 确认则全部拒绝，网页/目标应用内伪造确认无效。
4. 审计日志能完整重放“谁在何时对哪个窗口做了什么、是否确认、结果如何”，同时不保存明文密码、OTP、token、完整 clipboard 或未授权窗口像素。
5. 窗口遮挡、DPI/缩放、多显示器、窗口移动、accessibility tree 变化和焦点抢夺测试不会误点其他 app；目标身份不确定时 fail closed。
6. Skill/MCP/Plugin 尝试自行打开 Computer Use、扩大 app/window、延长 TTL 或禁用可见状态/日志均被 policy 拒绝并记录。
7. macOS 与 Windows 各完成 OS 权限首次请求、拒绝、撤销、再次授权和升级后回归；Linux/未支持平台显示明确不可用，不伪造能力。
8. Labs kill switch 能在不升级整个应用的情况下阻止新授权并终止活动控制；安全回归与人工红队通过后才能扩大级别。

## 非目标

- 不默认 bundle/启用 UI-TARS、UFO、Browser Use、nut.js 或其他全局控制 runtime；它们只能作为经过供应链与威胁建模的实验参考。
- 不承诺无人监督的全桌面自治，不隐藏控制状态，不允许“记住永久授权”。
- 不用 Computer Use 替代已有 SDK、API、MCP、Browser broker 或 OS 原生自动化；有结构化接口时优先结构化接口。
- 不在本需求自动发送消息、付款、删除、发布或绕过验证码/系统 consent。

## 依赖与激活条件

- 本记录未迁移为 GitHub Issue。只有 [[REQ-106]] 的 owning Issue 完成验收、Browser broker 的隔离/接管/审计经安全测试后，才可新建 Issue 提议激活。
- 激活前必须另立/修订 ADR，完成跨平台 threat model、隐私影响评估、OS 权限 UX、供应链与 kill-switch 运维负责人拍板。
- 与 [[C25]] 执行面、[[ADR-019]] run 落盘/retention、[[REQ-094]] Inspector 和组织级 capability policy 对齐；不得因用户安装某扩展而自动解锁。
