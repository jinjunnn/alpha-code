# 非目标(NON_GOALS)

> 最后更新:2026-07-09(用户拍板:条款 6 修订——撤回「不支持非 Mac 平台」的 Windows 部分,桌面 = macOS + Windows;ADR-026 / REQ-076)
> 上一版:2026-07-05(REQ-008 拍板:用户群三条收口——团队协作/企业租户不做、非技术用户转入目标画像)
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效
> 这是 scope creep 的第一道防线。`/app:challenge` 与 `app-drift-detector` 会**主动引用**这里否决偏离。

## 明确不做的事

1. **不改 `opencode/packages/**` 源码** — 理由:任何源码改动都会在 upstream 升级时冲突,直接违背北极星。唯一例外:确需新增 `/api/*` HTTP 路由时,走 `patches/` 补丁层并集中到单一插入点(见 DECISIONS ADR-002),且必须显式记录。
2. **不重写 agent core / session / context / tool 引擎** — 理由:这是 opencode `@opencode-ai/core` 的职责,白嫖即可,重写=自找维护地狱。
3. **不编辑 opencode 既有的任何文件** — 理由(修订自 ADR-005):本仓库现在**是** opencode 的 fork(不是"避免 fork"),但只能**新增**文件;一旦改动 upstream 既有文件,fork-sync 就会冲突,直接违背北极星。等价于原来的"opencode 只读",只是现在在 fork 内部执行。**ADR-020 例外(2026-07-03)**:`packages/{app,ui}` 已冻结、退出每日同步,其相对 dev 的 diff 是冻结本意非违例;冻结包对 alpha 依然只读(写 = 仅受控 re-freeze)。
4. **不把核心后端行为长期压在 `experimental.*` plugin hook 上** — 理由:这些 hook 官方标注 unstable、会改签名;可用于过渡,但凡依赖必须在 DECISIONS 标注风险与回退方案。
5. **不前端绕过 SDK 直连 core 内部模块** — 理由:`@opencode-ai/sdk` 是唯一稳定契约;绕过它=把自己焊死在 opencode 内部实现上。
6. **不复活 web/tui/console/enterprise 形态;不做 Linux**(修订 2026-07-09,ADR-026)— 理由:聚焦桌面,避免被 opencode 的 27 包全形态拖住。原「不支持非 Mac 平台」经用户拍板**部分撤回:Windows 纳入支持**(桌面 = macOS 首发 + Windows,载体 REQ-076);Linux 与非桌面形态照旧不做(electron-builder linux 段保留休眠不启用)。连带:Parked D7 的重开条件(「NON_GOALS#6 撤回」)就此触发,其关切并入 REQ-076 T3。

## 明确不服务的用户群
> 修订(2026-06-18):产品转向**多用户分发 + 云端多租户**(见 ADR-010/011),原"个人 Mac 工具"前提作废。
> 修订(2026-07-05,REQ-008 拍板):三条〔待补〕全部收口 → debates/2026-07-05-req008-positioning-briefs.md。
- **团队协作(共享 workspace/会话)— 不做**(D1):多租户 = 多个独立租户共享云执行平台,无共享会话/workspace;E13 已 rejected。重开条件 = 真实付费团队需求出现**且**上游出现多用户原语。
- **企业租户(合同/SSO/合规)— 不做**(D2);重评触发 = 真实付费企业线索,或 C 仓 license 体系成熟后主动重评。
- ~~要求零配置开箱即用的非技术用户~~ → **已移出本清单(D3):非技术用户(小白)正式纳入目标用户群**(分期:当前仅规范文档 REQ-026,新手引导/支持面暂缓)——见 POSITIONING 目标用户。

## 明确不追求的指标
- opencode 上游已覆盖的功能数量(那不是我们的功劳,会干扰北极星)。
- **后端**自定义代码总量(越多越偏离后端"薄定制层"的初衷)。**前端不适用**:ADR-016 起前端由 alpha 全面接管,前端体量按需增长、不作为反指标。

## 明确不引入的技术
- 与 opencode `catalog`(根 package.json)冲突的 `effect` / `solid-js` / `@opentui/*` 版本 — 理由:版本漂移会让消费侧编译崩。
- 第二套 agent 框架 / 第二个 LLM 编排层 — 理由:opencode 的 `llm` + `core` 已经是基座。
- 多 build 渠道 / 多部署环境的**主动维护**(dev / beta / staging / prod 并行发布)— 理由:单人只发 **prod 一个 app**(ui-mac 的 dev/beta 机制保留不删但非默认,见 [[ADR-012]]);云平台亦单一部署。降低维护面,合既有 ship 偏好(无 dev 模式、单一入口)。注:此"环境"指**运行/部署**,与 `dev` git 分支(上游镜像,见 [[ADR-005]])无关——后者不是环境。

## 撤回条件(什么时候可以把某条从 NON_GOALS 删除)
- 条款 1/2/3:若决定彻底脱离 opencode upstream(放弃升级继承),整套隔离前提失效,本文件需重写。
- 条款 4:若 opencode 把对应 hook 转正(去掉 `experimental.` 前缀),可解除风险标注。
